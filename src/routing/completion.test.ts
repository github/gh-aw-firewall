import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runMainWorkflow, WorkflowDependencies } from '../cli-workflow';
import type { ModelRoutingBootstrapState, WrapperConfig } from '../types';
import { verifyRoutingCompletion, waitForRoutingSelection } from './bootstrap';

// No planner or provider traffic: the production session, observation,
// persistence, host completion verifier and workflow exit handling remain real.
jest.mock('../../containers/api-proxy/proxy-request', () => ({}));
jest.mock('../../containers/api-proxy/key-validation', () => ({ cachedModels: {} }));
jest.mock('../../containers/api-proxy/otel', () => ({}));

interface RoutingHooks {
  bodyTransform(body: Buffer): void;
  onSseData(line: string): void;
  onSseInspectionStart(): void;
  onSseInspectionComplete(): void;
  onUpstreamResponseHeaders(headers: Record<string, string>, upstream: EventEmitter): void;
  rejected?: boolean;
}

interface Request {
  method: string;
  url: string;
  headers: Record<string, string>;
  awfRouting?: RoutingHooks;
}

class Response extends EventEmitter {
  statusCode = 200;
  writableFinished = false;
  write() { return true; }
  end() {
    this.writableFinished = true;
    this.emit('finish');
  }
}

interface Session {
  start(): Promise<unknown>;
  shutdown(): Promise<void>;
  completeShutdown(): void;
  observeRequest(req: Request, res: Response, adapter: { name: string }): void;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createProductionRoutingSession } = require('../../containers/api-proxy/routing-runtime') as {
  createProductionRoutingSession(options: {
    rawConfig: string;
    outputDir: string;
    observer: { record(record: Record<string, unknown>): void };
    createController(): { run(): Promise<unknown> };
  }): Session;
};

const selection = {
  schema: 'awf-routing-selection/v1', engine: 'copilot', provider: 'copilot',
  choice: { id: 'choice-test', model: 'github-copilot/test-model' }, wire_model: 'test-model',
};

describe('routed host workflow completion', () => {
  let root: string;
  let session: Session;
  let records: Record<string, unknown>[];
  let state: ModelRoutingBootstrapState;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-routing-completion-'));
    state = {
      root, inputDir: root, outputDir: root, inputFile: path.join(root, 'conversation.json'),
      containerInputFile: '/run/awf-routing/input/conversation.json',
      containerOutputDir: '/run/awf-routing/output',
    };
    records = [];
    session = createProductionRoutingSession({
      rawConfig: '{}', outputDir: root,
      observer: { record: record => records.push(record) },
      createController: () => ({ run: async () => ({ ok: true, selection }) }),
    });
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function request({ model = 'test-model', provider = 'copilot', streaming = false, url = '/chat/completions' } = {}) {
    const req: Request = { method: 'POST', url, headers: {} };
    const res = new Response();
    session.observeRequest(req, res, { name: provider });
    const hooks = req.awfRouting!;
    hooks.bodyTransform(Buffer.from(JSON.stringify({ model, stream: streaming })));
    const upstream = new EventEmitter();
    hooks.onUpstreamResponseHeaders({
      'content-type': streaming ? 'text/event-stream' : 'application/json',
    }, upstream);
    if (streaming) hooks.onSseInspectionStart();
    return {
      res, upstream, hooks,
      finish(status = 200) {
        res.statusCode = status;
        upstream.emit('end');
        res.end();
        if (streaming) hooks.onSseInspectionComplete();
      },
      cancel() {
        res.emit('close');
        upstream.emit('aborted');
        if (streaming) hooks.onSseInspectionComplete();
      },
    };
  }

  function run(agent: () => void | Promise<void>, harnessExit = 0) {
    const config: WrapperConfig = {
      allowedDomains: [], agentCommand: 'synthetic harness', logLevel: 'error',
      keepContainers: false, workDir: root, buildLocal: false,
      imageRegistry: 'unused', imageTag: 'unused', networkIsolation: true,
      enableApiProxy: true, experimentalModelRouting: true,
      modelRouting: {
        objective: { goal: 'cost', mode: 'balanced' },
        task: { conversationFile: state.inputFile },
      },
    };
    const dependencies: WorkflowDependencies = {
      ensureFirewallNetwork: jest.fn(), setupHostIptables: jest.fn(),
      prepareRouting: async () => state,
      writeConfigs: async () => {
        fs.mkdirSync(path.join(root, 'api-proxy-logs'));
      },
      startContainers: async (_work, _domains, _logs, _pull, _network, ready) => {
        await session.start();
        await ready?.();
      },
      waitForRoutingSelection,
      runAgentCommand: async () => {
        await agent();
        return { exitCode: harnessExit };
      },
      verifyRoutingCompletion: async routingState => verifyRoutingCompletion(routingState),
    };
    return runMainWorkflow(config, dependencies, {
      logger: { info: jest.fn(), success: jest.fn(), warn: jest.fn() },
      performCleanup: async () => {
        await session.shutdown();
        session.completeShutdown();
      },
    });
  }

  it('returns 0 after a selected-model 503 recovers, retaining failed request telemetry', async () => {
    await expect(run(() => {
      request().finish(503);
      expect(fs.readdirSync(root)).not.toContain('runtime-failure.json');
      request().finish();
    })).resolves.toBe(0);
    expect(records).toEqual([
      expect.objectContaining({ stage: 'request', outcome: 'failed', status: 503 }),
      expect.objectContaining({ stage: 'request', outcome: 'completed', status: 200 }),
    ]);
  });

  it('returns 0 with aborted telemetry for a final client cancellation during drain', async () => {
    await expect(run(() => {
      request().finish();
      const abandoned = request({ streaming: true });
      setImmediate(() => abandoned.cancel());
    })).resolves.toBe(0);
    expect(records).toEqual([
      expect.objectContaining({ stage: 'request', outcome: 'completed', status: 200 }),
      expect.objectContaining({ stage: 'request', outcome: 'aborted', status: 200 }),
    ]);
  });

  it.each([503, 502])('rejects with exit 78/provider_unavailable for unrecovered HTTP %s', async status => {
    await expect(run(() => {
      request().finish(status);
      request().finish(status);
    })).rejects.toMatchObject({ exitCode: 78, message: expect.stringContaining('provider_unavailable') });
    expect(records.filter(record => record.stage === 'failure')).toHaveLength(1);
  });

  it.each([
    { model: 'other-model' },
    { provider: 'openai' },
    { streaming: true },
  ])('does not recover on another route or an incomplete stream: %j', async options => {
    await expect(run(() => {
      request().finish(503);
      const unrelated = request(options);
      if (options.streaming) unrelated.cancel();
      else unrelated.finish();
    })).rejects.toMatchObject({ exitCode: 78 });
  });

  it('does not recover on HTTP 200 without a terminal streaming success', async () => {
    await expect(run(() => {
      request().finish(503);
      request({ streaming: true }).finish();
    })).rejects.toMatchObject({ exitCode: 78, message: expect.stringContaining('provider_unavailable') });
    expect(records.filter(record => record.stage === 'request').map(record => record.outcome))
      .toEqual(['failed', 'failed']);
  });

  it('preserves a real upstream reset even when the downstream then closes', async () => {
    await expect(run(() => {
      request().finish();
      const failed = request({ streaming: true });
      failed.upstream.emit('aborted');
      failed.cancel();
    })).rejects.toMatchObject({ exitCode: 78, message: expect.stringContaining('provider_unavailable') });
  });

  it('does not mask an SSE error with a later terminal event on the same response', async () => {
    await expect(run(() => {
      const failed = request({ streaming: true });
      failed.hooks.onSseData('{"type":"response.failed","response":{"error":{"code":"rate_limited"}}}');
      failed.hooks.onSseData('[DONE]');
      failed.finish();
    })).rejects.toMatchObject({ exitCode: 78, message: expect.stringContaining('rate_limited') });
  });

  it.each([true, false])('settles concurrent requests in fully inspected completion order (recovery last: %s)', async recoveryLast => {
    const outcome = run(() => {
      const failed = request({ streaming: true });
      const recovered = request({ streaming: true });
      failed.hooks.onSseData('{"type":"error","error":{"code":"provider_unavailable"}}');
      recovered.hooks.onSseData('[DONE]');
      // Both downstream responses finish before their SSE inspection drains.
      failed.res.end();
      recovered.res.end();
      setImmediate(() => {
        const order = recoveryLast ? [failed, recovered] : [recovered, failed];
        order.forEach(response => response.hooks.onSseInspectionComplete());
      });
    });
    if (recoveryLast) await expect(outcome).resolves.toBe(0);
    else await expect(outcome).rejects.toMatchObject({ exitCode: 78 });
    expect(records.filter(record => record.stage === 'failure')).toHaveLength(recoveryLast ? 0 : 1);
  });

  it('accepts Codex-style terminal success followed by client close as recovery', async () => {
    await expect(run(() => {
      request().finish(503);
      const completed = request({ streaming: true, url: '/responses' });
      completed.hooks.onSseData('{"type":"response.completed","response":{"status":"completed"}}');
      completed.cancel();
    })).resolves.toBe(0);
    expect(records[records.length - 1]).toMatchObject({ outcome: 'client_closed', status: 200 });
  });

  it('preserves independent invocation-budget/harness exit 1 after successful routing', async () => {
    await expect(run(() => {
      request().finish();
      request({ streaming: true }).cancel();
      for (let i = 0; i < 6; i++) {
        const rejected = request();
        rejected.hooks.rejected = true;
        rejected.finish(429);
      }
    }, 1)).resolves.toBe(1);
    expect(records.filter(record => record.outcome === 'rejected')).toHaveLength(6);
    expect(records.filter(record => record.stage === 'failure')).toEqual([]);
  });
});
