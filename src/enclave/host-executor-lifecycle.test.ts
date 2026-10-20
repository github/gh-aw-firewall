import {
  HostExecutorLifecycleRegistry, drainHostExecutorLifecycle, type HostExecutorDrainHooks,
  type HostExecutorRunLifecycle,
} from './host-executor-lifecycle';
import type { HostExecutorServer } from './host-executor-server';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('backend-neutral host executor lifecycle', () => {
  const owner = {};
  let registry: HostExecutorLifecycleRegistry<object, { close(): Promise<void> }>;
  let server: HostExecutorServer;

  beforeEach(() => {
    registry = new HostExecutorLifecycleRegistry('Test enclave');
    server = {
      socketPath: '/private/executor.sock', capabilityPath: '/private/capability',
      closeAdmissions: jest.fn(), close: jest.fn().mockResolvedValue(undefined),
    };
  });

  it('reports host-service readiness without requiring persistent workload readiness', async () => {
    await expect(registry.ready('/run', owner)).rejects.toThrow(/full preflight/);
    const starting = deferred();
    const start = registry.start('/run', owner, 'run-id', async (run) => {
      await starting.promise;
      run.server = server;
    });
    await expect(registry.ready('/run', owner)).rejects.toThrow(/full preflight/);
    starting.resolve();
    await start;
    await expect(registry.ready('/run', owner)).resolves.toBeUndefined();
    await expect(registry.ready('/run', {})).rejects.toThrow(/full preflight/);
  });

  it('closes admissions when shutdown races startup and shares draining', async () => {
    const starting = deferred();
    const stopping = deferred();
    const start = registry.start('/run', owner, 'run-id', async (run) => {
      await starting.promise;
      run.server = server;
    });
    const close = jest.fn(async (run: HostExecutorRunLifecycle<object, { close(): Promise<void> }>) => {
      expect(run.draining).toBe(true);
      await run.server!.close();
      await stopping.promise;
    });
    const stop = registry.stop('/run', owner, jest.fn(), close);
    const again = registry.stop('/run', owner, jest.fn(), close);
    expect(close).not.toHaveBeenCalled();
    await expect(registry.ready('/run', owner)).rejects.toThrow(/full preflight/);
    starting.resolve();
    await start;
    expect(server.closeAdmissions).toHaveBeenCalled();
    stopping.resolve();
    await Promise.all([stop, again]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(registry.completed('/run', 'run-id')).toBe(true);
    expect(registry.completed('/run', 'other-run')).toBe(false);
    expect(registry.has('/run')).toBe(false);
  });

  it('does not let a different configuration close an owned run', async () => {
    await registry.start('/run', owner, 'run-id', async (run) => { run.server = server; });
    expect(() => registry.closeAdmissions('/run', {})).toThrow(/owned by another/);
    await expect(registry.stop('/run', {}, jest.fn(), jest.fn())).rejects.toThrow(/owned by another/);
    await expect(registry.ready('/run', owner)).resolves.toBeUndefined();
    expect(server.closeAdmissions).not.toHaveBeenCalled();
  });

  it('retains failed startup state and awaits it before cleanup', async () => {
    const starting = deferred();
    const start = registry.start('/run', owner, 'run-id', async () => {
      await starting.promise;
      throw new Error('startup failed');
    });
    const failed = expect(start).rejects.toThrow('startup failed');
    const close = jest.fn(async (run: HostExecutorRunLifecycle<object, { close(): Promise<void> }>) => {
      expect(run.failed).toBe(true);
      throw new Error('recovery required');
    });
    const stop = registry.stop('/run', owner, jest.fn(), close);
    starting.resolve();
    await failed;
    await expect(stop).rejects.toThrow('recovery required');
    expect(registry.has('/run')).toBe(true);
    expect(registry.completed('/run', 'run-id')).toBe(false);
    await expect(registry.start('/run', owner, 'new-id', jest.fn())).rejects.toThrow(/already exists/);
    await expect(registry.stop('/run', owner, jest.fn(), close)).rejects.toThrow('recovery required');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('requires adapter reconciliation when no in-memory run exists', async () => {
    await expect(registry.stop('/run', owner, () => {
      throw new Error('unreaped journals');
    }, jest.fn())).rejects.toThrow('unreaped journals');
  });

  it('publishes shutdown state before a synchronous admission-close callback reenters', async () => {
    await registry.start('/run', owner, 'run-id', async (run) => { run.server = server; });
    let readiness: Promise<void> | undefined;
    server.closeAdmissions = () => {
      readiness = registry.ready('/run', owner);
      void readiness.catch(() => undefined);
    };
    await registry.stop('/run', owner, jest.fn(), async () => undefined);
    await expect(readiness).rejects.toThrow(/full preflight/);
  });
});

describe('backend-neutral drain, recovery and protected evidence ordering', () => {
  let events: string[];
  let hooks: HostExecutorDrainHooks;
  beforeEach(() => {
    events = [];
    hooks = {
      preserveEvidence: async () => { events.push('evidence'); },
      drain: async () => { events.push('drain-and-reconcile'); return true; },
      collectDiagnostics: async (drained) => { events.push(`diagnostics:${drained}`); },
      releaseStorage: async () => { events.push('release'); },
      combineErrors: (cleanup, evidence) => Object.assign(new Error('cleanup and evidence failed'), {
        errors: [cleanup, evidence],
      }),
    };
  });

  it('reconciles resources before releasing storage, then preserves final evidence', async () => {
    await drainHostExecutorLifecycle(hooks);
    expect(events).toEqual(['evidence', 'drain-and-reconcile', 'diagnostics:true', 'release', 'evidence']);
  });

  it('retains storage on incomplete cleanup and still captures protected diagnostics', async () => {
    hooks.drain = async () => { throw new Error('uncertain cleanup'); };
    await expect(drainHostExecutorLifecycle(hooks)).rejects.toThrow('uncertain cleanup');
    expect(events).toEqual(['evidence', 'diagnostics:false', 'evidence']);
  });

  it('still drains and preserves both failures when evidence capture fails', async () => {
    const cleanup = new Error('uncertain cleanup');
    const evidence = new Error('evidence failure');
    hooks.preserveEvidence = async () => { events.push('evidence'); throw evidence; };
    hooks.drain = async () => { events.push('drain'); throw cleanup; };
    await expect(drainHostExecutorLifecycle(hooks)).rejects.toMatchObject({ errors: [cleanup, evidence] });
    expect(events).toEqual(['evidence', 'drain', 'diagnostics:false', 'evidence']);
  });

  it('does not mistake diagnostics failure for unreaped backend resources', async () => {
    hooks.collectDiagnostics = async () => { throw new Error('diagnostics failure'); };
    await expect(drainHostExecutorLifecycle(hooks)).rejects.toThrow('diagnostics failure');
    expect(events).toEqual(['evidence', 'drain-and-reconcile', 'release', 'evidence']);
  });
});
