import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import execa from 'execa';
import { setAwfDockerHost } from '../docker-host';
import { hostExecutorVmRunId } from './host-executor-journal';
import { HostExecutorInvocationDiagnostics } from './host-executor-diagnostics';
import {
  captureEnclaveProxyContainerLog, preservePublicEnclaveProxyDiagnostics,
} from './proxy-debug-retention';
import type { HostExecutorRunState, HostExecutorInvocationPlan } from './host-executor-server';

jest.mock('execa', () => jest.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })));

describe('public run-cumulative enclave proxy diagnostics', () => {
  let root: string;
  const runId = 'a'.repeat(32);
  const invocationId = 'b'.repeat(32);
  const debugId = createHash('sha256').update(`awf-enclave-proxy-debug-v1:${runId}`).digest('hex').slice(0, 32);
  const retainedFile = () => path.join(root, 'journal', 'diagnostics', `${runId}-${debugId}.proxy-debug.json`);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(process.cwd(), '.proxy-debug-test-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('writes one protected run record without attributing cumulative events to invocations', async () => {
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
    await preservePublicEnclaveProxyDiagnostics(run, {
      scope: 'run-cumulative', status: 'captured', records: 2,
      local: { '403': 1 }, upstream: { '401': 1 },
      ...{ authorization: 'PRIVATE_CREDENTIAL', path: '/PRIVATE_PATH' },
    }, [
      { schemaVersion: 1, origin: 'local', status: 403, ...{ authorization: 'PRIVATE_CREDENTIAL' } },
      { schemaVersion: 1, origin: 'upstream', status: 401, ...{ body: 'PRIVATE_BODY' } },
    ], containerLog);
    expect(fs.readdirSync(invocation)).toEqual([]);
    const retained = JSON.parse(fs.readFileSync(retainedFile(), 'utf8'));
    expect(retained).toMatchObject({ runId, scope: 'run-cumulative', component: 'enclave-proxy-debug' });
    expect(retained.events).toEqual([
      { schemaVersion: 1, origin: 'local', status: 403 },
      { schemaVersion: 1, origin: 'upstream', status: 401 },
    ]);
    expect(Buffer.byteLength(JSON.stringify(retained.events))).toBeLessThanOrEqual(256 * 1024);
    expect(retained.containerLog).toBe(
      'source=stdout level=info event=request_complete status=200\n' +
      'source=stdout level=warn event=upstream_error_response status=401\n' +
      'source=stderr level=error event=request_error\ncapture_status=captured dropped=0\n',
    );
    expect(fs.statSync(retainedFile()).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(retainedFile(), 'utf8')).not.toMatch(/PRIVATE|authorization|path/);
  });

  it('rejects a symlinked journal directory rather than writing outside protected storage', async () => {
    const run = { runId, journalDir: path.join(root, 'journal') } as HostExecutorRunState;
    fs.symlinkSync(root, run.journalDir!);
    await expect(preservePublicEnclaveProxyDiagnostics(
      run,
      { scope: 'run-cumulative', status: 'missing' },
      [],
      'capture_status=unavailable\n',
    )).rejects.toThrow(/Unsafe journal ancestor/);
    expect(fs.existsSync(path.join(root, 'enclave-proxy-events.jsonl'))).toBe(false);
  });

  it.each(['empty', 'missing', 'unsafe'] as const)(
    'writes no fabricated events for %s and leaves the status in the protected journal', async status => {
      const run = { runId, journalDir: path.join(root, 'journal') } as HostExecutorRunState;
      await preservePublicEnclaveProxyDiagnostics(run, {
        scope: 'run-cumulative', status, ...{ authorization: 'PRIVATE_CREDENTIAL' },
      }, [], 'capture_status=unavailable\n');
      expect(JSON.parse(fs.readFileSync(retainedFile(), 'utf8'))).toMatchObject({
        scope: 'run-cumulative', events: [], containerLog: 'capture_status=unavailable\n',
      });
    });

  it.each(['enclave_model_budget_rejected', 'rate_limited', 'request_validation_failed', 'model_fallback_exhausted',
    'enclave_model_capability_missing', 'enclave_model_capability_scheme', 'enclave_model_capability_format',
    'enclave_model_capability_signature', 'enclave_model_capability_claims', 'enclave_model_capability_claims_changed',
    'enclave_model_token_limit',
    'enclave_model_token_body_missing', 'enclave_model_token_input_reservation',
    'enclave_model_token_request_json', 'enclave_model_token_request_shape',
    'enclave_model_token_output_conflict', 'enclave_model_token_output_shape',
    'enclave_model_token_stream_options', 'enclave_model_token_budget_exhausted'])(
    'retains only the fixed %s rejection event and drops free-form fields', async event => {
      const log = await captureEnclaveProxyContainerLog(async () => ({
        exitCode: 0, stdout: '', stderr: JSON.stringify({
          level: 'warn', event, status: 403, reason: 'PRIVATE_CREDENTIAL',
        }) + '\n',
      }));
      const run = { runId, journalDir: path.join(root, 'journal') };
      await preservePublicEnclaveProxyDiagnostics(run, { scope: 'run-cumulative', status: 'empty' }, [], log);
      expect(JSON.parse(fs.readFileSync(retainedFile(), 'utf8')).containerLog)
        .toBe(`source=stderr level=warn event=${event} status=403\ncapture_status=captured dropped=0\n`);
    });

  it('uses the selected Docker daemon and filters an unsolicited remote daemon', async () => {
    const previous = process.env.DOCKER_HOST;
    const docker = jest.mocked(execa);
    try {
      process.env.DOCKER_HOST = 'tcp://untrusted-remote:2375';
      setAwfDockerHost('unix:///selected/docker.sock');
      await captureEnclaveProxyContainerLog();
      expect(docker).toHaveBeenLastCalledWith('docker',
        ['logs', '--tail', '200', 'awf-enclave-agent-api-proxy'],
        expect.objectContaining({ env: expect.objectContaining({ DOCKER_HOST: 'unix:///selected/docker.sock' }) }));
      setAwfDockerHost(undefined);
      await captureEnclaveProxyContainerLog();
      expect(docker).toHaveBeenLastCalledWith('docker', expect.any(Array),
        expect.objectContaining({ env: expect.not.objectContaining({ DOCKER_HOST: expect.anything() }) }));
    } finally {
      setAwfDockerHost(undefined);
      if (previous === undefined) delete process.env.DOCKER_HOST;
      else process.env.DOCKER_HOST = previous;
    }
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
