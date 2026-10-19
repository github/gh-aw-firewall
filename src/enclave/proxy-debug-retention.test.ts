import * as fs from 'fs';
import * as path from 'path';
import { HostExecutorInvocationDiagnostics, hostExecutorVmRunId } from './host-executor-journal';
import {
  captureEnclaveProxyContainerLog, preservePublicEnclaveProxyDiagnostics,
} from './proxy-debug-retention';
import type { HostExecutorRunState, HostExecutorInvocationPlan } from './host-executor-server';

describe('public per-invocation enclave proxy diagnostics', () => {
  let root: string;
  const runId = 'a'.repeat(32);
  const invocationId = 'b'.repeat(32);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(process.cwd(), '.proxy-debug-test-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('writes exact smoke-collector filenames in the protected agent invocation directory only', async () => {
    const run = { runId, journalDir: path.join(root, 'journal') } as HostExecutorRunState;
    const plan = {
      runId, entryId: 'agent', invocationId, executorKind: 'agent',
    } as HostExecutorInvocationPlan;
    new HostExecutorInvocationDiagnostics(run, plan);
    const vmId = hostExecutorVmRunId(plan);
    const debugRoot = path.join(root, 'protected', 'cloud-hypervisor');
    const invocation = path.join(debugRoot, vmId);
    fs.mkdirSync(invocation, { recursive: true, mode: 0o700 });
    fs.chmodSync(invocation, 0o700);
    const containerLog = await captureEnclaveProxyContainerLog(async () => ({
      exitCode: 0,
      stdout: [
        { level: 'info', event: 'request_complete', status: 200,
          authorization: 'PRIVATE_CREDENTIAL', body: 'PRIVATE_PAYLOAD' },
        { level: 'warn', event: 'upstream_error_response', status: 401,
          response_body: 'PRIVATE_RESPONSE', request_id: 'PRIVATE_ID' },
      ].map(value => JSON.stringify(value) + '\n').join(''),
      stderr: JSON.stringify({ level: 'error', event: 'request_error',
        error: 'PRIVATE_ERROR', path: '/PRIVATE_PATH' }) + '\n',
    }));
    await preservePublicEnclaveProxyDiagnostics(run, debugRoot, path.join(root, 'protected'), {
      scope: 'run-cumulative', status: 'captured', records: 2,
      local: { '403': 1 }, upstream: { '401': 1 },
      ...{ authorization: 'PRIVATE_CREDENTIAL', path: '/PRIVATE_PATH' },
    }, [
      { schemaVersion: 1, origin: 'local', status: 403, ...{ authorization: 'PRIVATE_CREDENTIAL' } },
      { schemaVersion: 1, origin: 'upstream', status: 401, ...{ body: 'PRIVATE_BODY' } },
    ], containerLog);
    expect(fs.readdirSync(invocation).sort()).toEqual([
      'enclave-proxy-container.log', 'enclave-proxy-events.jsonl',
    ]);
    const events = fs.readFileSync(path.join(invocation, 'enclave-proxy-events.jsonl'), 'utf8');
    expect(events.split('\n').filter(Boolean).map(line => JSON.parse(line))).toEqual([
      { schemaVersion: 1, origin: 'local', status: 403 },
      { schemaVersion: 1, origin: 'upstream', status: 401 },
    ]);
    expect(Buffer.byteLength(events)).toBeLessThanOrEqual(256 * 1024);
    expect(fs.readFileSync(path.join(invocation, 'enclave-proxy-container.log'), 'utf8')).toBe(
      'source=stdout level=info event=request_complete status=200\n' +
      'source=stdout level=warn event=upstream_error_response status=401\n' +
      'source=stderr level=error event=request_error\ncapture_status=captured dropped=0\n',
    );
    fs.rmSync(path.join(root, 'journal'), { recursive: true });
    for (const name of fs.readdirSync(invocation)) {
      const file = path.join(invocation, name);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(file, 'utf8')).not.toMatch(/PRIVATE|authorization|path/);
    }
  });

  it('rejects a symlinked invocation directory rather than writing outside the debug root', async () => {
    const run = { runId, journalDir: path.join(root, 'journal') } as HostExecutorRunState;
    const plan = {
      runId, entryId: 'agent', invocationId, executorKind: 'agent',
    } as HostExecutorInvocationPlan;
    new HostExecutorInvocationDiagnostics(run, plan);
    const debugRoot = path.join(root, 'protected', 'cloud-hypervisor');
    const vmId = hostExecutorVmRunId(plan);
    fs.mkdirSync(debugRoot, { recursive: true });
    fs.symlinkSync(root, path.join(debugRoot, vmId));
    await expect(preservePublicEnclaveProxyDiagnostics(
      run, debugRoot, path.join(root, 'protected'),
      { scope: 'run-cumulative', status: 'missing' },
      [],
      'capture_status=unavailable\n',
    )).rejects.toThrow(/Unsafe public enclave debug directory/);
    expect(fs.existsSync(path.join(root, 'enclave-proxy-events.jsonl'))).toBe(false);
  });

  it.each(['empty', 'missing', 'unsafe'] as const)(
    'writes no fabricated events for %s and leaves the status in the protected journal', async status => {
      const run = { runId, journalDir: path.join(root, 'journal') } as HostExecutorRunState;
      const plan = {
        runId, entryId: 'agent', invocationId, executorKind: 'agent',
      } as HostExecutorInvocationPlan;
      new HostExecutorInvocationDiagnostics(run, plan);
      const debugRoot = path.join(root, 'protected', 'cloud-hypervisor');
      const invocation = path.join(debugRoot, hostExecutorVmRunId(plan));
      fs.mkdirSync(invocation, { recursive: true, mode: 0o700 });
      fs.chmodSync(invocation, 0o700);
      await preservePublicEnclaveProxyDiagnostics(run, debugRoot, path.join(root, 'protected'), {
        scope: 'run-cumulative', status, ...{ authorization: 'PRIVATE_CREDENTIAL' },
      }, [], 'capture_status=unavailable\n');
      expect(fs.readFileSync(path.join(invocation, 'enclave-proxy-events.jsonl'), 'utf8')).toBe('');
      expect(fs.readFileSync(path.join(invocation, 'enclave-proxy-container.log'), 'utf8'))
        .toBe('capture_status=unavailable\n');
    });

  it('omits raw or unknown stdout/stderr fields and limits the projected container log', async () => {
    const log = await captureEnclaveProxyContainerLog(async () => ({
      exitCode: 0,
      stdout: [
        JSON.stringify({ level: 'info', event: 'request_complete', status: 403,
          bearer: 'PRIVATE_BEARER', prompt: 'PRIVATE_PROMPT' }),
        JSON.stringify({ level: 'error', event: 'PRIVATE_EVENT', status: 401 }),
        'PRIVATE_NON_JSON',
      ].join('\n') + '\n',
      stderr: '',
    }));
    expect(log).toBe('source=stdout level=info event=request_complete status=403\n' +
      'capture_status=captured dropped=2\n');
    expect(await captureEnclaveProxyContainerLog(async () => {
      throw new Error('PRIVATE_DOCKER_ERROR');
    })).toBe('capture_status=unavailable\n');
  });
});
