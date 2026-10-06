import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { validateSchema, validateValueAgainstSchema } from '../../src/bounded-execution/finite-schema';

const root = path.resolve(__dirname, '../..');
const harnessPath = path.join(root, 'scripts/ci/cloud-hypervisor-enclave-live-smoke.js');
const workflowPath = path.join(root, '.github/workflows/test-cloud-hypervisor-enclaves.yml');
type StartupChild = { exitCode: number | null; signalCode: string | null };
const harness = require(harnessPath) as {
  startupDiagnostic(child: StartupChild | undefined, reason: string, stage: string, file: string, startupErrorFile?: string): {
    schemaVersion: number;
    phase: string;
    stage: string;
    reason: string;
    category: string;
    exitCode: number | null;
    signal: string | null;
    logInspection: string;
  };
  waitForBroker(child: StartupChild, container: string, deadline: number, diagnostics: {
    stage: string; stderrFile: string;
  }): Promise<void>;
  failedSpawns: WeakSet<StartupChild>;
  removePrivateAwfLogs(stdoutFile: string, stderrFile: string, startupErrorFiles?: string[]): void;
  stopAwf(child: EventEmitter & { kill(signal: string): void }, graceMs: number, terminateMs: number): Promise<void>;
  trackAwfChild(child: ChildProcess): ChildProcess;
  RELEASE_ASSETS: string[];
  assertReleaseAssets(required: string[], published: string[]): void;
  assertNoSentinelLeak(directories: string[], logs: string[], sentinel: string): void;
  assertExpectedToolResult(response: unknown, requestId: number, expected: unknown, label: string): void;
  assertNoSuccessfulResult(response: unknown): void;
  assertRecoveredInvocation(
    before: {
      runId: string;
      invocationId: string;
      directory: string;
      directoryIdentity: unknown;
      ancestors: unknown;
      mount: unknown;
      snapshot: unknown;
      storage: {
        directory: string;
        parentIdentity: unknown;
        ancestors: unknown;
        directoryIdentity: unknown;
        mountedIdentity: unknown;
        mounts: unknown;
      };
    },
    after: {
      runId: string;
      invocationId: string;
      state: string;
      directory: string;
      directoryIdentity: unknown;
      ancestors: unknown;
      mount: unknown;
      snapshot: unknown;
      storage: {
        directory: string;
        parentIdentity: unknown;
        ancestors: unknown;
        directoryIdentity: unknown;
        mountedIdentity: unknown;
        mounts: unknown;
      };
    },
    records: Array<{ record: { runId: string; invocationId: string } }>,
  ): void;
  buildAgentGuestProbe(): { expected: Record<string, unknown>; schema: unknown; prompt: string };
  buildAgentEnospcProbe(): { expected: Record<string, unknown>; schema: unknown; prompt: string };
  buildConstantObjectSchema(expected: Record<string, unknown>): unknown;
  buildEnospcProbeScript(maxStorageMib?: number): string;
  buildOomProbeScript(): string;
  buildScriptGuestProbe(): { expected: Record<string, unknown>; schema: unknown };
  parsePublicToolResult(response: unknown, requestId: number): { status: string; result?: unknown };
  requestMcp(
    endpoint: string,
    apiKey: string,
    requestId: number,
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<unknown>;
};

describe('sanitized host startup diagnostics', () => {
  let directory: string;
  let stderrFile: string;
  const child = { exitCode: 1, signalCode: null };
  const known = 'The Docker primary-agent runtime is unavailable; enclaves never fall back';
  const sentinel = 'AWF_ENCLAVE_LIVE_OUTPUT_SENTINEL_repository_secret_/private/path';
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-startup-diagnostic-'));
    stderrFile = path.join(directory, 'awf.stderr.log');
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const diagnose = (file: string) => harness.startupDiagnostic(child, 'exit', 'initial', file);

  it.each([
    [known, 'container-runtime'],
    ['Cloud Hypervisor enclave runtime configuration is missing', 'configuration'],
    ['Preflight storage requires root-owned trusted directories', 'host-preflight'],
    ['Bounded enclave preflight requires trusted host tool "mount"', 'host-preflight'],
    ['Trusted enclave artifact has invalid content size', 'artifact'],
    ['agent enclave rootfs does not match its trusted manifest digest and size', 'artifact'],
    ['Cloud Hypervisor enclave host service could not start', 'host-service'],
    ['Trusted enclave MCP gateway container is unavailable', 'broker'],
    ['Unsafe Cloud Hypervisor enclave recovery directory; private state is preserved', 'recovery-state'],
  ])('classifies the exact host fatal header: %s', (message, category) => {
    fs.writeFileSync(stderrFile, `[ERROR] Fatal error: Error: ${message}\n    at ${sentinel}\n`);
    const diagnostic = diagnose(stderrFile);
    expect(diagnostic).toEqual({
      schemaVersion: 1, phase: 'pre-broker', stage: 'initial', reason: 'exit',
      category, exitCode: 1, signal: null, logInspection: 'bounded',
    });
    expect(JSON.stringify(diagnostic)).not.toContain(sentinel);
    expect(Buffer.byteLength(JSON.stringify(diagnostic))).toBeLessThanOrEqual(256);
  });

  it.each([
    sentinel,
    `{"message":"${known}","secret":"${sentinel}"}`,
    `[ERROR] Fatal error: Error: ${known} ${sentinel}`,
    `[ERROR] Fatal error: Error: ${sentinel}\n[ERROR] Fatal error: Error: ${known}`,
    `[ERROR] Fatal error: Error: ${sentinel}\n${known}`,
    `[WARN] ${known}\n${sentinel}`,
    `\u001b[31m[ERROR] Fatal error: Error: ${known}\u001b[39m`,
  ])('does not infer a category from arbitrary content', (input) => {
    fs.writeFileSync(stderrFile, input);
    expect(diagnose(stderrFile).category).toBe('unknown');
    expect(JSON.stringify(diagnose(stderrFile))).not.toContain(sentinel);
  });

  it('uses the fixed unsupported-host type without exporting its variable message or cause', () => {
    fs.writeFileSync(stderrFile, `[ERROR] Fatal error: CloudHypervisorUnsupportedHostError: ${sentinel}\n`);
    expect(diagnose(stderrFile).category).toBe('unsupported-host');
    expect(JSON.stringify(diagnose(stderrFile))).not.toContain(sentinel);
  });

  it('prefers the existing structured host startup record, matching the entire message', () => {
    const startupErrorFile = path.join(directory, 'awf-startup-error.json');
    fs.writeFileSync(stderrFile, `[ERROR] Fatal error: Error: ${known}`);
    for (const message of [
      'Trusted enclave artifact has invalid content size',
      `${known}\n${sentinel}`,
      sentinel,
    ]) {
      fs.writeFileSync(startupErrorFile, JSON.stringify({
        timestamp: sentinel, phase: 'startup', message,
      }));
      const diagnostic = harness.startupDiagnostic(child, 'exit', 'initial', stderrFile, startupErrorFile);
      expect(diagnostic).toEqual({
        schemaVersion: 1, phase: 'pre-broker', stage: 'initial', reason: 'exit',
        category: message === 'Trusted enclave artifact has invalid content size' ? 'artifact' : 'unknown',
        exitCode: 1, signal: null, logInspection: 'structured',
      });
      expect(JSON.stringify(diagnostic)).not.toContain(sentinel);
    }
  });

  it('falls back to bounded stderr when a structured record is missing, invalid, oversized or a symlink', () => {
    const startupErrorFile = path.join(directory, 'awf-startup-error.json');
    const record = JSON.stringify({ timestamp: 'test', phase: 'startup', message: known });
    fs.writeFileSync(stderrFile, sentinel);
    const assertUnknown = () => expect(harness.startupDiagnostic(
      child, 'exit', 'initial', stderrFile, startupErrorFile,
    )).toMatchObject({ category: 'unknown', logInspection: 'bounded' });
    assertUnknown();
    for (const content of [sentinel, record.replace('"startup"', '"workload"'), 'x'.repeat(16385)]) {
      fs.writeFileSync(startupErrorFile, content);
      assertUnknown();
    }
    fs.unlinkSync(startupErrorFile);
    const target = path.join(directory, 'structured-private');
    fs.writeFileSync(target, record);
    fs.symlinkSync(target, startupErrorFile);
    assertUnknown();
  });

  it('rejects missing, oversized, symlink and non-regular diagnostics without echoing errors', () => {
    const assertUnavailable = () => expect(diagnose(stderrFile)).toMatchObject({
      category: 'unknown', logInspection: 'unavailable',
    });
    assertUnavailable();
    fs.writeFileSync(stderrFile, `[ERROR] Fatal error: Error: ${known}\n${'x'.repeat(64 * 1024)}`);
    const read = jest.spyOn(require('fs'), 'readSync');
    assertUnavailable();
    expect(read).not.toHaveBeenCalled();
    fs.unlinkSync(stderrFile);
    const target = path.join(directory, 'private');
    fs.writeFileSync(target, `[ERROR] Fatal error: Error: ${known}`);
    fs.symlinkSync(target, stderrFile);
    assertUnavailable();
    fs.unlinkSync(stderrFile);
    fs.mkdirSync(stderrFile);
    assertUnavailable();
  });

  it('rejects an in-place change during the descriptor-bounded read and closes the descriptor', () => {
    const content = `[ERROR] Fatal error: Error: ${known}`;
    fs.writeFileSync(stderrFile, content);
    const nodeFs = require('fs') as typeof fs;
    const originalRead = fs.readSync;
    const read = jest.spyOn(nodeFs, 'readSync').mockImplementation((...args) => {
      const result = originalRead(...args);
      fs.writeFileSync(stderrFile, 'x'.repeat(Buffer.byteLength(content)));
      fs.utimesSync(stderrFile, 0, 1000);
      return result;
    });
    const close = jest.spyOn(nodeFs, 'closeSync');
    expect(diagnose(stderrFile)).toMatchObject({ category: 'unknown', logInspection: 'unavailable' });
    expect(close).toHaveBeenCalledWith(read.mock.calls[0][0]);
  });

  it('does not follow a pathname replaced after opening', () => {
    fs.writeFileSync(stderrFile, sentinel);
    const nodeFs = require('fs') as typeof fs;
    const originalFstat = fs.fstatSync;
    let replaced = false;
    jest.spyOn(nodeFs, 'fstatSync').mockImplementation((...args) => {
      const result = originalFstat(...args);
      if (!replaced) {
        replaced = true;
        fs.renameSync(stderrFile, path.join(directory, 'original'));
        fs.writeFileSync(stderrFile, `[ERROR] Fatal error: Error: ${known}`);
      }
      return result;
    });
    expect(diagnose(stderrFile).category).toBe('unknown');
  });

  it.each([
    [{ exitCode: 1, signalCode: null }, 'exit'],
    [{ exitCode: null, signalCode: 'SIGKILL' }, 'signal'],
    [{ exitCode: null, signalCode: null }, 'timeout'],
    [{ exitCode: null, signalCode: null }, 'spawn-failure'],
  ])('emits before cleanup and preserves failure for %s / %s', async (status, reason) => {
    fs.writeFileSync(stderrFile, `[ERROR] Fatal error: Error: ${known}`);
    const stdoutFile = path.join(directory, 'awf.stdout.log');
    fs.writeFileSync(stdoutFile, sentinel);
    if (reason === 'spawn-failure') harness.failedSpawns.add(status);
    const records: string[] = [];
    jest.spyOn(console, 'error').mockImplementation((record) => {
      expect(fs.existsSync(stderrFile)).toBe(true);
      records.push(record);
    });
    try {
      await expect(harness.waitForBroker(status, 'unused', reason === 'timeout' ? 0 : Date.now() + 1000, {
        stage: 'recovery', stderrFile,
      })).rejects.toThrow(/AWF|Timed out/);
    } finally {
      harness.removePrivateAwfLogs(stdoutFile, stderrFile);
    }
    expect(records).toHaveLength(1);
    expect(records[0]).toMatch(/^AWF_HOST_STARTUP_DIAGNOSTIC /);
    const record = JSON.parse(records[0].slice('AWF_HOST_STARTUP_DIAGNOSTIC '.length));
    expect(record).toEqual({
      schemaVersion: 1, phase: 'pre-broker', stage: 'recovery', reason,
      category: reason === 'spawn-failure' ? 'unknown' : 'container-runtime',
      exitCode: status.exitCode, signal: status.signalCode,
      logInspection: reason === 'spawn-failure' ? 'unavailable' : 'bounded',
    });
    expect(records[0]).not.toContain(sentinel);
    expect(Buffer.byteLength(`${records[0]}\n`)).toBeLessThanOrEqual(256);
    expect(fs.existsSync(stderrFile)).toBe(false);
    expect(fs.existsSync(stdoutFile)).toBe(false);
  });

  it('bounds all metadata even for malformed child state', () => {
    expect(harness.startupDiagnostic({
      exitCode: 9999, signalCode: sentinel,
    }, sentinel, sentinel, stderrFile)).toEqual({
      schemaVersion: 1, phase: 'pre-broker', stage: 'initial', reason: 'unknown',
      category: 'unknown', exitCode: null, signal: null, logInspection: 'unavailable',
    });
  });

  it('does not emit startup diagnostics once the broker has become ready', async () => {
    const output = jest.spyOn(console, 'error').mockImplementation(() => {});
    let isolatedHarness!: typeof harness;
    const inspect = jest.fn(() => ({ status: 0, stdout: 'healthy\n' }));
    jest.doMock('child_process', () => ({
      ...jest.requireActual('child_process'),
      spawnSync: inspect,
    }));
    try {
      jest.isolateModules(() => { isolatedHarness = require(harnessPath); });
      const running = { exitCode: null, signalCode: null };
      await expect(isolatedHarness.waitForBroker(running, 'broker', Date.now() + 1000, {
        stage: 'initial', stderrFile,
      })).resolves.toBeUndefined();
      expect(inspect).toHaveBeenCalledTimes(1);
      expect(inspect.mock.calls[0]).toEqual([
        'docker',
        ['inspect', '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}', 'broker'],
        expect.objectContaining({ timeout: expect.any(Number), killSignal: 'SIGKILL' }),
      ]);
      expect(output).not.toHaveBeenCalled();
    } finally {
      jest.dontMock('child_process');
    }
  });

  it.each(['exit', 'signal', 'spawn-failure'])('handles an actual child %s without disclosing a subprocess error', async (reason) => {
    fs.writeFileSync(stderrFile, sentinel);
    const childProcess = harness.trackAwfChild(reason === 'spawn-failure'
      ? spawn(path.join(directory, 'missing-private-executable'))
      : spawn(process.execPath, ['-e', reason === 'exit'
        ? 'process.exit(1)' : 'process.kill(process.pid, "SIGTERM")']));
    await new Promise<void>((resolve) => childProcess.once('close', () => resolve()));
    const output = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(harness.waitForBroker(childProcess, 'unused', Date.now() + 1000, {
      stage: 'initial', stderrFile,
    })).rejects.toThrow(/AWF/);
    const record = String(output.mock.calls[0][0]);
    expect(JSON.parse(record.slice('AWF_HOST_STARTUP_DIAGNOSTIC '.length)))
      .toMatchObject({ reason, category: 'unknown', phase: 'pre-broker' });
    expect(record).not.toContain(directory);
    expect(record).not.toContain(sentinel);
  });

  it('attempts removal of every raw file despite a cleanup error without exposing it', () => {
    const stdoutFile = path.join(directory, 'awf.stdout.log');
    const startupErrorFile = path.join(directory, 'awf-startup-error.json');
    for (const file of [stdoutFile, stderrFile, startupErrorFile]) fs.writeFileSync(file, sentinel);
    const nodeFs = require('fs') as typeof fs;
    const originalRemove = fs.rmSync;
    const remove = jest.spyOn(nodeFs, 'rmSync').mockImplementation((...args) => {
      if (args[0] === stdoutFile) throw new Error(sentinel);
      originalRemove(...args);
    });
    expect(() => harness.removePrivateAwfLogs(stdoutFile, stderrFile, [startupErrorFile]))
      .toThrow('Could not remove live enclave private diagnostic files');
    expect(remove).toHaveBeenCalledTimes(3);
    expect(fs.existsSync(stderrFile)).toBe(false);
    expect(fs.existsSync(startupErrorFile)).toBe(false);
  });

  it('bounds cleanup after startup timeout and clears timers after normal exit', async () => {
    jest.useFakeTimers();
    try {
      const stuck = Object.assign(new EventEmitter(), { kill: jest.fn() });
      const pending = harness.stopAwf(stuck, 60_000, 5000);
      const rejection = expect(pending).rejects.toThrow('AWF did not exit within the live fixture cleanup deadline');
      jest.advanceTimersByTime(60_000);
      expect(stuck.kill).toHaveBeenCalledWith('SIGTERM');
      jest.advanceTimersByTime(5000);
      await rejection;
      expect(stuck.kill).toHaveBeenCalledWith('SIGKILL');
      expect(stuck.listenerCount('exit')).toBe(0);
      const normal = Object.assign(new EventEmitter(), { kill: jest.fn() });
      const stopped = harness.stopAwf(normal, 60_000, 5000);
      normal.emit('exit', 0);
      await expect(stopped).resolves.toBeUndefined();
      expect(jest.getTimerCount()).toBe(0);
      expect(normal.kill).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('wires both launches, disables color, removes raw logs even with retained recovery state, and never uploads them', () => {
    const source = fs.readFileSync(harnessPath, 'utf8');
    expect(source).toContain("stage: 'initial', stderrFile: awfErr");
    expect(source).toContain("stage: 'recovery', stderrFile: awfErr");
    expect(source).toContain("NO_COLOR: '1', FORCE_COLOR: '0'");
    expect(source.indexOf('removePrivateAwfLogs(awfOut, awfErr,'))
      .toBeLessThan(source.indexOf('if (keepArtifacts) {'));
    expect(fs.readFileSync(workflowPath, 'utf8')).not.toMatch(/upload-artifact/);
  });
});

describe('Cloud Hypervisor enclave live acceptance harness', () => {
  it('requires the package-matched release assets, never development artifacts', () => {
    expect(() => harness.assertReleaseAssets(harness.RELEASE_ASSETS, harness.RELEASE_ASSETS))
      .not.toThrow();
    expect(() => harness.assertReleaseAssets(harness.RELEASE_ASSETS, []))
      .toThrow(/release-attested.*not accepted/);
    const source = fs.readFileSync(harnessPath, 'utf8');
    expect(source).toContain('setup-enclave-artifacts.sh');
    expect(source).toContain("run('gh', [");
    expect(source).toContain(
      "apiTimeoutMs: require('../../dist/types/runtime-options').CLOUD_HYPERVISOR_DEFAULT_API_TIMEOUT_MS",
    );
    expect(source).not.toMatch(/DEVELOPMENT_ALLOW_UNATTESTED|allow-unattested|fake.?vm|mock.?manager/i);
  });

  it('accepts only canonical bounded public MCP results', () => {
    expect(harness.parsePublicToolResult({
      jsonrpc: '2.0',
      id: 3,
      result: {
        structuredContent: { status: 'ok', result: true },
        content: [{ type: 'text', text: '{"status":"ok","result":true}' }],
      },
    }, 3)).toEqual({ status: 'ok', result: true });
    expect(harness.parsePublicToolResult({
      jsonrpc: '2.0',
      id: 4,
      result: {
        structuredContent: { status: 'error' },
        content: [{ type: 'text', text: '{"status":"error"}' }],
      },
    }, 4)).toEqual({ status: 'error' });
    for (const invalid of [
      { jsonrpc: '2.0', id: 3, error: { message: 'failed' } },
      { jsonrpc: '2.0', id: 3, result: { structuredContent: { status: 'ok', debug: 'raw' }, content: [] } },
      { jsonrpc: '2.0', id: 3, result: { structuredContent: { status: 'ok', result: true }, content: [{ type: 'text', text: '{"status":"error"}' }] } },
    ]) {
      expect(() => harness.parsePublicToolResult(invalid, 3)).toThrow();
    }
  });

  it('requires live agent identity, capabilities, API proxy peer/port, and denial of unrelated routes', () => {
    const probe = harness.buildAgentGuestProbe();
    expect(probe.expected).toEqual({
      uid: 65534,
      gid: 65534,
      onlyExpectedInterfaces: true,
      emptyEffectiveCapabilities: true,
      noNewPrivileges: true,
      processLimit: 47,
      fileSizeLimit: 268435456,
      openFileLimit: 1024,
      apiProxyReachable: true,
      wrongPortBlocked: true,
      wrongPeerBlocked: true,
      githubPeerBlocked: true,
      publicEgressBlocked: true,
    });
    expect(probe.prompt).toContain('172.31.0.30", 10002');
    expect(probe.prompt).toContain('172.31.0.30", 10000');
    expect(probe.prompt).toContain('172.31.0.99", 10002');
    expect(probe.prompt).toContain('172.31.0.40", 8080');
    expect(probe.prompt).toContain('1.1.1.1", 443');
    const python = probe.prompt.split("python3 - <<'PY'\n")[1].split('\nPY')[0];
    expect(Buffer.byteLength(probe.prompt)).toBeLessThanOrEqual(4096);
    expect(() => execFileSync('python3', ['-c', 'import sys; compile(sys.stdin.read(), "<agent-probe>", "exec")'], {
      input: python,
    })).not.toThrow();
    expect(() => harness.assertExpectedToolResult({
      jsonrpc: '2.0',
      id: 5,
      result: {
        structuredContent: { status: 'ok', result: probe.expected },
        content: [{ type: 'text', text: JSON.stringify({ status: 'ok', result: probe.expected }) }],
      },
    }, 5, probe.expected, 'agent')).not.toThrow();
    expect(() => harness.assertExpectedToolResult({
      jsonrpc: '2.0',
      id: 5,
      result: {
        structuredContent: { status: 'ok', result: { ...probe.expected, wrongPortBlocked: false } },
        content: [{ type: 'text', text: JSON.stringify({
          status: 'ok', result: { ...probe.expected, wrongPortBlocked: false },
        }) }],
      },
    }, 5, probe.expected, 'agent')).toThrow(/guest assertion failed/);
  });

  it('exercises guest-visible aggregate ENOSPC and verifies the bounded probe cleans its data', () => {
    const script = harness.buildEnospcProbeScript();
    expect(script).toContain('errno.ENOSPC');
    expect(script).toContain('"/output"');
    expect(script).toContain('os.unlink(name)');
    expect(script).toContain('range(16)');
    expect(() => harness.buildEnospcProbeScript(768)).toThrow(/supported role ceiling/);
    expect(() => execFileSync('python3', ['-c', 'import sys; compile(sys.stdin.read(), "<enospc-probe>", "exec")'], {
      input: script,
    })).not.toThrow();
    const agentProbe = harness.buildAgentEnospcProbe();
    expect(agentProbe.expected).toEqual({ enospcObserved: true, probeFilesRemoved: true });
    expect(Buffer.byteLength(agentProbe.prompt)).toBeLessThanOrEqual(4096);
    const agentScript = agentProbe.prompt.split("python3 - <<'PY'\n")[1].split('\nPY')[0];
    expect(agentScript).toContain('range(8)');
    expect(() => execFileSync('python3', ['-c', 'import sys; compile(sys.stdin.read(), "<agent-enospc-probe>", "exec")'], {
      input: agentScript,
    })).not.toThrow();
    expect(agentProbe.prompt).toContain('print(encoded)');
    expect(() => harness.assertExpectedToolResult({
      jsonrpc: '2.0',
      id: 6,
      result: {
        structuredContent: {
          status: 'ok',
          result: { enospcObserved: true, probeFilesRemoved: true },
        },
        content: [{
          type: 'text',
          text: '{"status":"ok","result":{"enospcObserved":true,"probeFilesRemoved":true}}',
        }],
      },
    }, 6, { enospcObserved: true, probeFilesRemoved: true }, 'ENOSPC')).not.toThrow();
  });

  it('requires a guest OOM kill counter increase, not merely an error response', () => {
    const script = harness.buildOomProbeScript();
    expect(script).toContain('"/proc/vmstat"');
    expect(script).toContain('name == "oom_kill"');
    expect(script).toContain('signal == -9');
    expect(script).toContain('after > before');
    expect(() => execFileSync('python3', ['-c', 'import sys; compile(sys.stdin.read(), "<oom-probe>", "exec")'], {
      input: script,
    })).not.toThrow();
  });

  it('uses the production finite-schema grammar for every live response contract', () => {
    const scriptProbe = harness.buildScriptGuestProbe();
    const agentProbe = harness.buildAgentGuestProbe();
    const agentEnospc = harness.buildAgentEnospcProbe();
    const scriptEnospcExpected = { enospcObserved: true, probeFilesRemoved: true };
    const oomExpected = { childKilledByOom: true, oomKillCounterIncreased: true };
    const schemasAndValues = [
      [scriptProbe.schema, scriptProbe.expected],
      [agentProbe.schema, agentProbe.expected],
      [agentEnospc.schema, agentEnospc.expected],
      [harness.buildConstantObjectSchema(scriptEnospcExpected), scriptEnospcExpected],
      [harness.buildConstantObjectSchema(oomExpected), oomExpected],
      [{ type: 'enum', values: ['AWF_ENCLAVE_LIVE_AGENT_RESULT'] }, 'AWF_ENCLAVE_LIVE_AGENT_RESULT'],
      [{ type: 'const', value: true }, true],
    ] as const;
    for (const [rawSchema, value] of schemasAndValues) {
      const parsed = validateSchema(rawSchema);
      expect(parsed.valid).toBe(true);
      if (parsed.valid) expect(validateValueAgainstSchema(parsed.schema, value)).toBe(true);
    }
  });

  it('requires identity-checked crash recovery without accepting replayed success', () => {
    const before = {
      runId: 'a'.repeat(32),
      invocationId: 'b'.repeat(32),
      state: 'pending',
      directory: '/host/invocation',
      directoryIdentity: { device: 1, inode: 2 },
      ancestors: [{ path: '/host', identity: { device: 1, inode: 3 } }],
      mount: { mountId: 1, device: 2 },
      snapshot: { path: '/storage/artifacts/run-1', identity: { device: 3, inode: 4 } },
      storage: {
        directory: '/storage',
        parentIdentity: { device: 1, inode: 5 },
        ancestors: [{ path: '/', identity: { device: 1, inode: 1 } }],
        directoryIdentity: { device: 4, inode: 5 },
        mountedIdentity: { device: 4, inode: 6 },
        mounts: [{ mountId: 7, device: 8 }],
      },
    };
    const cleaned = { ...before, state: 'cleaned' };
    expect(() => harness.assertRecoveredInvocation(before, cleaned, [{ record: cleaned }]))
      .not.toThrow();
    expect(() => harness.assertRecoveredInvocation(before, before, [{ record: before }]))
      .toThrow(/exact interrupted invocation/);
    expect(() => harness.assertRecoveredInvocation(before, cleaned, [
      { record: cleaned }, { record: cleaned },
    ])).toThrow(/exact interrupted invocation/);
    expect(() => harness.assertRecoveredInvocation(before, {
      ...cleaned,
      storage: { ...before.storage, directoryIdentity: { device: 99, inode: 99 } },
    }, [{ record: cleaned }])).toThrow(/exact interrupted invocation/);
    expect(() => harness.assertNoSuccessfulResult({
      result: { structuredContent: { status: 'ok' } },
    })).toThrow(/successful result/);
    expect(() => harness.assertNoSuccessfulResult({
      error: { code: -32603, message: 'interrupted' },
    })).not.toThrow();
    const source = fs.readFileSync(harnessPath, 'utf8');
    expect(source).toContain("process.kill(vmmPid, 'SIGKILL')");
    expect(source).toContain("awf.kill('SIGKILL')");
    expect(source).toContain("awf = launchAwf('recovery')");
    expect(source).toContain("recoveryTools = await requestMcp");
    expect(source).toContain("open(\"/output/cancel-probe-started\"");
    expect(source).toContain("cancellationController.abort()");
  });

  it('preserves first-run diagnostics and isolates recovery state', () => {
    const source = fs.readFileSync(harnessPath, 'utf8');
    expect(source).toContain('...artifacts.enclaveArtifactEnvironment');
    expect(source).toContain("path.join(root, 'awf-work-recovery')");
    expect(source).toContain("path.join(root, 'awf-config-recovery.json')");
    expect(source).toContain('captureStderr: true');
    expect(source).toContain('...preRestartLogContents');
    expect(source).toContain('process.exitCode = 1');
    expect(source).toContain('fs.chmodSync(workspace, 0o755)');
    expect(source).toContain("mode: 0o644");
  });

  it('propagates public-client cancellation by closing its in-flight MCP request', async () => {
    let bodyReceived!: () => void;
    let clientDisconnected!: () => void;
    const received = new Promise<void>((resolve) => { bodyReceived = resolve; });
    const disconnected = new Promise<void>((resolve) => { clientDisconnected = resolve; });
    const server = http.createServer((request, response) => {
      request.on('end', bodyReceived);
      request.resume();
      response.on('close', clientDisconnected);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test MCP server did not bind');
    try {
      const controller = new AbortController();
      const pending = harness.requestMcp(
        `http://127.0.0.1:${address.port}/mcp`,
        'test-gateway-key',
        1,
        'tools/call',
        {},
        controller.signal,
      );
      await received;
      controller.abort();
      await expect(pending).resolves.toBeUndefined();
      await disconnected;
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it('destroys stalled public MCP requests when their bounded timeout expires', async () => {
    let requestClosed!: () => void;
    const closed = new Promise<void>((resolve) => { requestClosed = resolve; });
    const server = http.createServer((request, response) => {
      request.on('close', requestClosed);
      response.on('close', requestClosed);
      request.resume();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test MCP server did not bind');
    try {
      await expect(harness.requestMcp(
        `http://127.0.0.1:${address.port}/mcp`,
        'test-gateway-key',
        2,
        'tools/call',
        {},
        undefined,
        25,
      )).rejects.toThrow(/request failed/);
      await closed;
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it('detects synthetic raw-output leaks without echoing the sentinel', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-enclave-redaction-'));
    const sentinel = 'AWF_ENCLAVE_LIVE_OUTPUT_SENTINEL_synthetic';
    try {
      const diagnostic = path.join(directory, 'audit.jsonl');
      fs.writeFileSync(diagnostic, '{"category":"success"}\n');
      expect(() => harness.assertNoSentinelLeak([directory], ['safe'], sentinel)).not.toThrow();
      fs.writeFileSync(diagnostic, `{"message":"${sentinel}"}\n`);
      try {
        harness.assertNoSentinelLeak([directory], [], sentinel);
        throw new Error('expected sentinel leak rejection');
      } catch (error) {
        expect((error as Error).message).not.toContain(sentinel);
        expect((error as Error).message).toMatch(/sentinel escaped/);
      }
      expect(() => harness.assertNoSentinelLeak([], [sentinel], sentinel)).toThrow(/captured log/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('scans the opened diagnostic even if its pathname is replaced during inspection', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-enclave-scan-race-'));
    const diagnostic = path.join(directory, 'audit.jsonl');
    const displaced = path.join(directory, 'audit.original');
    const sentinel = 'AWF_ENCLAVE_LIVE_OUTPUT_SENTINEL_race';
    const nodeFs = require('fs') as typeof fs;
    fs.writeFileSync(diagnostic, sentinel);
    const originalStat = fs.statSync;
    const originalFstat = fs.fstatSync;
    const replace = () => {
      fs.renameSync(diagnostic, displaced);
      fs.writeFileSync(diagnostic, 'safe replacement');
    };
    const stat = jest.spyOn(nodeFs, 'statSync').mockImplementation((...args) => {
      const result = originalStat(...args);
      if (args[0] === diagnostic) replace();
      return result;
    });
    const fstat = jest.spyOn(nodeFs, 'fstatSync').mockImplementation((...args) => {
      const result = originalFstat(...args);
      replace();
      return result;
    });
    try {
      expect(() => harness.assertNoSentinelLeak([directory], [], sentinel))
        .toThrow(/sentinel escaped/);
    } finally {
      stat.mockRestore();
      fstat.mockRestore();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a diagnostic replaced by a symlink before opening without exposing paths', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-enclave-scan-link-'));
    const diagnostic = path.join(directory, 'audit.jsonl');
    const target = path.join(directory, 'private.original');
    const nodeFs = require('fs') as typeof fs;
    const originalOpen = fs.openSync;
    fs.writeFileSync(diagnostic, 'safe');
    fs.writeFileSync(target, 'private data');
    const open = jest.spyOn(nodeFs, 'openSync').mockImplementation((...args) => {
      if (args[0] === diagnostic) {
        fs.unlinkSync(diagnostic);
        fs.symlinkSync(target, diagnostic);
      }
      return originalOpen(...args);
    });
    try {
      expect(() => harness.assertNoSentinelLeak([directory], [], 'sentinel'))
        .toThrow('Could not inspect live enclave diagnostic file');
    } finally {
      open.mockRestore();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('bounds reads of a growing diagnostic and closes the descriptor on rejection', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-enclave-scan-growth-'));
    const diagnostic = path.join(directory, 'audit.jsonl');
    const nodeFs = require('fs') as typeof fs;
    const originalFstat = fs.fstatSync;
    fs.writeFileSync(diagnostic, 'safe');
    const fstat = jest.spyOn(nodeFs, 'fstatSync').mockImplementation((...args) => {
      const result = originalFstat(...args);
      fs.truncateSync(diagnostic, 16 * 1024 * 1024 + 1);
      return result;
    });
    const read = jest.spyOn(nodeFs, 'readSync');
    const close = jest.spyOn(nodeFs, 'closeSync');
    try {
      expect(() => harness.assertNoSentinelLeak([directory], [], 'sentinel'))
        .toThrow(/exceeded the scan bound/);
      expect(read).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledWith(fstat.mock.calls[0][0]);
    } finally {
      fstat.mockRestore();
      read.mockRestore();
      close.mockRestore();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('gates KVM acceptance separately and fails closed after explicit opt-in', () => {
    const workflow = fs.readFileSync(workflowPath, 'utf8');
    expect(workflow).toContain('run_live_kvm:');
    expect(workflow).toContain('default: false');
    expect(workflow).toContain('assertGithubHostedRunnerEligibility()');
    expect(workflow).toContain('cloud-hypervisor-enclave-live-smoke.js');
    expect(workflow).toContain("if: github.event_name == 'workflow_dispatch' && inputs.run_live_kvm");
    expect(workflow).not.toMatch(/continue-on-error|\|\| true|exit 0/);
  });

  it('invokes both executor tools over the public MCP HTTP route', () => {
    const source = fs.readFileSync(harnessPath, 'utf8');
    expect(source).toContain('/mcp/awf-enclave');
    expect(source).toContain("name: 'enclave_run_script'");
    expect(source).toContain("name: 'enclave_run_agent'");
    expect(source).toContain("'tools/call'");
    expect(source).not.toContain('executor.sock');
    expect(source).not.toContain('host-executor-client');
  });
});
