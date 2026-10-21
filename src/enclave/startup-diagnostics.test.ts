import * as fs from 'fs';
import * as path from 'path';
import { captureEnclaveStartupDiagnostics, enclaveStartupDiagnosticTestHelpers } from './startup-diagnostics';
import { useTempDir } from '../test-helpers/docker-test-fixtures.test-utils';
import { mockExecaFn } from '../test-helpers/mock-execa.test-utils';
import { logger } from '../logger';
import { spawnSync } from 'child_process';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('../test-helpers/mock-execa.test-utils').execaMockFactory());
jest.mock('../logger', () => ({ logger: { warn: jest.fn() } }));

const startupDiagnostics =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../../containers/enclave/mcp-server/startup-diagnostics.js');
const { createStartupReporter, runStartupStage, startupDiagnostic } = startupDiagnostics;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildRuntimeTelemetryRecord } = require('../../containers/enclave/script-executor/runtime-telemetry.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { probeTarget, selectedProbeIds } = require('../../containers/enclave/mcp-server/environment-probes.js');
const {
  classifyLogs, safeControlNetworkMembership, safeImageIdentity, safeState,
} = enclaveStartupDiagnosticTestHelpers;

describe('bounded enclave startup evidence', () => {
  const { getDir } = useTempDir();
  const state = '{"status":"exited","running":false,"exitCode":1,"oomKilled":false,"hasError":true}';
  const sensitive = 'Bearer SECRET capability=CAP private/repo /awf/seed/private';

  function snapshots(directory = path.join(getDir(), 'squid-logs')) {
    const root = path.join(directory, 'enclave-startup');
    return fs.readdirSync(root).map(name => {
      const file = path.join(root, name, 'diagnostic.json');
      return { file, text: fs.readFileSync(file, 'utf8') };
    });
  }

  beforeEach(() => {
    mockExecaFn.mockReset();
    jest.mocked(logger.warn).mockClear();
  });

  it('origin output drops messages, unknown codes, paths and non-AWF frames', () => {
    const error = new TypeError(sensitive);
    Object.assign(error, {
      code: 'ENOENT',
      stack: `TypeError: ${sensitive}\n`
        + '    at load (/opt/awf/enclave/mcp-server/config.js:22:3)\n'
        + '    at seed (/awf/seed/private.js:4:1)\n'
        + '    at evil (/tmp/mcp-server/config.js:1:2)',
    });
    const diagnostic = startupDiagnostic(error, 'server-config');
    expect(diagnostic).toMatchObject({
      stage: 'server-config', code: 'ENOENT', errorType: 'TypeError',
      frames: [{ module: 'mcp-server/config.js', line: 22, column: 3 }],
    });
    expect(JSON.stringify(diagnostic)).not.toContain('SECRET');
    expect(startupDiagnostic({ message: sensitive, name: sensitive, code: sensitive }, sensitive))
      .toMatchObject({ stage: 'unknown', code: 'unknown', errorType: 'unknown', frames: [] });
  });

  it('separates each startup operation and records the exact failing handler operation', async () => {
    const records: Record<string, unknown>[] = [];
    const reporter = createStartupReporter((line: string) => records.push(JSON.parse(line)));
    reporter.configure({
      primaryBackend: 'cloud-hypervisor', executorBackend: 'cloud-hypervisor', executorKind: 'script',
    });
    reporter.plan(['script-reconcile', 'script-handler', 'tool-budget']);
    await runStartupStage(reporter, 'script-reconcile', 'script-reconciliation-failed', async () => undefined);
    await expect(runStartupStage(
      reporter, 'script-handler', 'script-handler-construction-failed',
      async () => { throw new Error(sensitive); },
    )).rejects.toThrow(sensitive);
    const context = reporter.failureContext();
    const terminal = startupDiagnostic(new Error(sensitive), reporter.currentStage, context);
    expect(records.map(record => [record.stage, record.status])).toEqual([
      ['script-reconcile', 'started'], ['script-reconcile', 'passed'],
      ['script-handler', 'started'], ['script-handler', 'failed'],
    ]);
    expect(terminal).toMatchObject({
      stage: 'script-handler', reasonId: 'script-handler-construction-failed',
      primaryBackend: 'cloud-hypervisor', executorBackend: 'cloud-hypervisor',
      executorKind: 'script', unattempted: ['tool-budget'],
    });
    expect(JSON.stringify([...records, terminal])).not.toContain('SECRET');
  });

  it.each([
    ['server-config', 'server-config-invalid'],
    ['audit', 'audit-initialization-failed'],
    ['seed-map', 'seed-catalog-invalid'],
    ['executors', 'executor-selection-invalid'],
    ['executor-state', 'executor-state-initialization-failed'],
    ['script-config', 'script-config-invalid'],
    ['script-selection', 'script-runner-initialization-failed'],
    ['script-available', 'script-availability-failed'],
    ['script-reconcile', 'script-reconciliation-failed'],
    ['script-handler', 'script-handler-construction-failed'],
    ['agent-config', 'agent-config-invalid'],
    ['agent-selection', 'agent-runner-initialization-failed'],
    ['agent-available', 'agent-availability-failed'],
    ['agent-reconcile', 'agent-reconciliation-failed'],
    ['agent-handler', 'agent-handler-construction-failed'],
    ['backend-consistency', 'backend-consistency-failed'],
    ['tool-budget', 'tool-budget-initialization-failed'],
    ['listener-binding', 'listener-binding-failed'],
    ['ready-file', 'ready-file-publication-failed'],
  ])('retains the exact failed operation and reason for %s', async (stage, reasonId) => {
    const records: Record<string, unknown>[] = [];
    const reporter = createStartupReporter((line: string) => records.push(JSON.parse(line)));
    const laterStage = stage === 'ready-file' ? 'listener-binding' : 'ready-file';
    reporter.plan([stage, laterStage]);
    const error = Object.assign(new Error(sensitive), { code: 'EIO' });
    await expect(runStartupStage(reporter, stage, reasonId, async () => { throw error; }))
      .rejects.toBe(error);
    const terminal = startupDiagnostic(error, reporter.currentStage, reporter.failureContext());
    expect(records.map(record => [record.stage, record.status])).toEqual([
      [stage, 'started'], [stage, 'failed'],
    ]);
    expect(terminal).toMatchObject({
      stage, reasonId, code: 'EIO', unattempted: [laterStage],
    });
    expect(JSON.stringify([records, terminal])).not.toContain('SECRET');
  });

  it('preserves recognized system classifications and rejects unrecognized reason fields', () => {
    const diagnostic = startupDiagnostic(
      Object.assign(new TypeError(sensitive), { code: 'EACCES' }),
      'audit',
      {
        attemptId: '01234567-89ab-cdef-0123-456789abcdef',
        sequence: 9,
        elapsedMs: 12,
        primaryBackend: 'docker',
        executorBackend: 'gvisor',
        executorKind: 'agent',
        reasonId: sensitive,
      },
    );
    expect(diagnostic).toMatchObject({
      code: 'EACCES', errorType: 'TypeError', reasonId: 'startup-operation-failed',
      attemptId: '01234567-89ab-cdef-0123-456789abcdef', sequence: 9, elapsedMs: 12,
    });
    expect(JSON.stringify(diagnostic)).not.toContain('SECRET');
  });

  it('accepts Cloud Hypervisor backends in runtime telemetry', () => {
    expect(buildRuntimeTelemetryRecord({
      primaryBackend: 'cloud-hypervisor',
      executorBackend: 'cloud-hypervisor',
      lifecycleClass: 'startup',
      capabilityState: 'supported',
      category: 'ready',
    })).toMatchObject({
      primaryBackend: 'cloud-hypervisor',
      executorBackend: 'cloud-hypervisor',
    });
  });

  it('records probe timeouts, missing paths, and selected prerequisite identifiers without paths', async () => {
    const timeoutFs = { promises: { lstat: () => new Promise(() => {}) } };
    const timedOut = await probeTarget('capability', '/private/path', 'file', 'read', timeoutFs, 5);
    expect(timedOut).toMatchObject({ presence: 'unknown', shape: 'unknown', reason: 'timeout' });
    const missing = await probeTarget('capability', '/definitely/missing', 'file', 'read', fs, 100);
    expect(missing).toMatchObject({ presence: 'absent', shape: 'unexpected', reason: 'missing' });
    const ids = selectedProbeIds({
      AWF_ENCLAVE_BACKEND: 'cloud-hypervisor',
      AWF_ENCLAVE_SEED_MAP_ENABLED: 'false',
      AWF_ENCLAVE_SCRIPT_ENABLED: 'true',
    });
    expect(ids).toContain('host-executor-socket');
    expect(ids).not.toContain('seed-map');
    expect(ids).not.toContain('seed-directory');
    expect(ids).not.toContain('docker-socket');
    const containerExecutorIds = selectedProbeIds({
      AWF_ENCLAVE_BACKEND: 'gvisor',
      AWF_ENCLAVE_SCRIPT_ENABLED: 'true',
      AWF_ENCLAVE_SEED_MAP_ENABLED: 'true',
    });
    expect(containerExecutorIds).toEqual(expect.arrayContaining([
      'seed-directory', 'docker-socket', 'docker-executable', 'script-seccomp',
    ]));
    expect(containerExecutorIds).not.toContain('host-executor-socket');
    const dockerIds = selectedProbeIds({
      AWF_ENCLAVE_BACKEND: 'docker',
      AWF_ENCLAVE_SCRIPT_ENABLED: 'true',
      AWF_ENCLAVE_AGENT_BACKEND: 'docker',
      AWF_ENCLAVE_AGENT_ENABLED: 'true',
      AWF_ENCLAVE_AGENT_DYNAMIC_ENABLED: 'true',
    });
    expect(dockerIds).toEqual(expect.arrayContaining(['seed-map', 'host-executor-socket', 'host-executor-capability']));
    expect(dockerIds).not.toEqual(expect.arrayContaining(['seed-directory']));
    expect(dockerIds).not.toContain('docker-socket');
    expect(dockerIds).not.toContain('delegation-channel');
    expect(JSON.stringify([timedOut, missing])).not.toContain('/private/path');
  });

  it('the actual server startup catch emits bounded progress and safe terminal diagnostics', () => {
    const result = spawnSync(process.execPath, [
      path.resolve(__dirname, '../../containers/enclave/mcp-server/server.js'),
    ], { env: {}, timeout: 5000, maxBuffer: 16384, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    const lines = result.stderr.trim().split('\n').map(line => JSON.parse(line));
    expect(lines.slice(0, 2)).toEqual([
      expect.objectContaining({ kind: 'startup-progress', stage: 'environment-probes', status: 'started' }),
      expect.objectContaining({ kind: 'startup-progress', stage: 'environment-probes', status: 'passed' }),
    ]);
    expect(lines[lines.length - 1]).toMatchObject({
      component: 'enclave-mcp-server', kind: 'startup-error',
      stage: 'server-config', state: 'failed', reasonId: 'server-config-invalid', errorType: 'Error',
    });
    expect(result.stderr).not.toMatch(/Missing required|auth-token|\/srv\/|\/run\//);
  });

  it('validates origin fields again rather than trusting container-produced JSON', () => {
    const output = classifyLogs(JSON.stringify({
      component: 'enclave-mcp-server', kind: 'startup-error', stage: sensitive,
      errorType: sensitive, code: sensitive, message: sensitive,
      frames: [
        { module: sensitive, line: 1, column: 1 },
        { module: 'mcp-server/server.js', line: sensitive, column: 1 },
        { module: 'mcp-server/server.js', line: 42, column: 9, secret: sensitive },
      ],
    }));
    expect(output).toMatchObject({
      source: 'origin', stage: 'unknown', errorType: 'unknown', code: 'unknown',
      state: 'unknown', attemptId: 'unavailable', reasonId: 'startup-operation-failed',
      frames: [{ module: 'mcp-server/server.js', line: 42, column: 9 }],
    });
    expect(JSON.stringify(output)).not.toContain('SECRET');
  });

  it('classifies legacy and module-load errors without retaining raw log evidence', () => {
    expect(classifyLogs(`Error: Cannot find module ${sensitive}\n code: MODULE_NOT_FOUND`))
      .toMatchObject({ source: 'docker-log-classification', errorType: 'Error', code: 'MODULE_NOT_FOUND' });
    expect(JSON.stringify(classifyLogs(`Error: EACCES ${sensitive}`))).not.toContain('SECRET');
    expect(classifyLogs('ENOENT\n' + 'x'.repeat(20000))).toMatchObject({ code: 'unknown' });
    const frames = Array.from({ length: 20 }, () => ({ module: 'mcp-server/server.js', line: 1, column: 1 }));
    expect(classifyLogs(JSON.stringify({
      component: 'enclave-mcp-server', kind: 'startup-error', frames,
    })).frames).toHaveLength(8);
  });

  it('retains only allowlisted structured progress and keeps image identity unavailable or matched explicitly', () => {
    const progress = classifyLogs(JSON.stringify({
      schemaVersion: 1, component: 'enclave-mcp-server', kind: 'startup-progress',
      stage: 'environment-probes', status: 'passed', sequence: 2, elapsedMs: 4,
      primaryBackend: 'cloud-hypervisor', executorBackend: 'cloud-hypervisor', executorKind: 'script',
      effectiveUid: 0, probes: [{
        id: 'capability', presence: 'present', observedType: 'file', expectedType: 'file',
        owner: 'root', mode: 'owner-only', access: 'allowed', shape: 'expected', path: sensitive,
      }],
      privateValue: sensitive,
    }));
    expect(progress).toMatchObject({
      progress: [{
        stage: 'environment-probes', status: 'passed', effectiveUid: 0,
        probes: [{ id: 'capability', access: 'allowed' }],
      }],
    });

    expect(JSON.stringify(progress)).not.toContain('SECRET');
    expect(safeImageIdentity('{}')).toMatchObject({
      identityStatus: 'unavailable', sourceRevisionStatus: 'unavailable',
    });
    const imageId = `sha256:${'a'.repeat(64)}`;
    expect(safeImageIdentity(
      JSON.stringify({ imageId }),
      JSON.stringify({
        imageId, sourceRevision: 'a'.repeat(40),
        repoDigests: [`ghcr.io/example/enclave@sha256:${'b'.repeat(64)}`, sensitive],
      }),
    )).toMatchObject({
      identityStatus: 'matched', containerImageId: imageId, inspectedImageId: imageId,
      sourceRevisionStatus: 'captured', repoDigests: [`sha256:${'b'.repeat(64)}`],
    });
    expect(JSON.stringify(safeImageIdentity('{}', JSON.stringify({ sourceRevision: sensitive }))))
      .not.toContain('SECRET');
    expect(safeImageIdentity(
      JSON.stringify({ imageId }),
      JSON.stringify({
        imageId: `sha256:${'f'.repeat(64)}`,
        sourceRevision: 'f'.repeat(40),
        repoDigests: [`ghcr.io/example/enclave@sha256:${'f'.repeat(64)}`],
      }),
    )).toMatchObject({
      identityStatus: 'mismatch',
      repoDigests: [],
      sourceRevision: null,
      sourceRevisionStatus: 'unavailable',
    });
  });

  it('captures exact control-network membership without retaining unexpected network names', () => {
    expect(safeControlNetworkMembership('awf-enclave-mcp-control\n')).toEqual({
      status: 'matched', networks: ['awf-enclave-mcp-control'], unexpectedNetworkCount: 0,
    });
    const membership = safeControlNetworkMembership(
      `awf-enclave-mcp-control\n${sensitive}\n`,
    );
    expect(membership).toEqual({
      status: 'mismatch', networks: ['awf-enclave-mcp-control'], unexpectedNetworkCount: 1,
    });
    expect(JSON.stringify(membership)).not.toContain('SECRET');
    expect(safeControlNetworkMembership('')).toMatchObject({ status: 'unavailable' });
  });

  it('retains separate startup and cleanup snapshots in firewall logs across attempts', async () => {
    const progressRecord = JSON.stringify({
      schemaVersion: 1, component: 'enclave-mcp-server', kind: 'startup-progress',
      attemptId: '01234567-89ab-cdef-0123-456789abcdef', sequence: 4, elapsedMs: 25,
      stage: 'script-available', status: 'passed', primaryBackend: 'cloud-hypervisor',
      executorBackend: 'cloud-hypervisor', executorKind: 'script',
    });
    mockExecaFn.mockImplementation(async (_command, args) => {
      if (args[0] === 'inspect' && String(args[2]).includes('NetworkSettings')) {
        return { exitCode: 0, stdout: 'awf-enclave-mcp-control\n', stderr: sensitive };
      }
      return args[0] === 'inspect'
        ? { exitCode: 0, stdout: state, stderr: sensitive }
        : { exitCode: 0, stdout: '', stderr: `${progressRecord}\nError: ENOENT ${sensitive}` };
    });
    const logDir = path.join(getDir(), 'firewall', 'logs');
    await captureEnclaveStartupDiagnostics(getDir(), logDir, 'startup-failure');
    await captureEnclaveStartupDiagnostics(getDir(), logDir, 'startup-failure');
    await captureEnclaveStartupDiagnostics(getDir(), logDir, 'shutdown-failure');
    const records = snapshots(logDir);
    expect(records).toHaveLength(3);
    for (const snapshot of records) {
      expect(snapshot.text).not.toContain('SECRET');
      expect(snapshot.text.length).toBeLessThan(2048);
      expect(fs.statSync(snapshot.file).mode & 0o777).toBe(0o644);
      expect(JSON.parse(snapshot.text)).toMatchObject({
        inspectStatus: 'captured', state: { exitCode: 1, oomKilled: false, hasError: true },
        logsStatus: 'classified', logs: { code: 'ENOENT' },
        serverAttemptId: '01234567-89ab-cdef-0123-456789abcdef',
        controlNetworkMembership: {
          status: 'matched', networks: ['awf-enclave-mcp-control'], unexpectedNetworkCount: 0,
        },
      });
      expect(JSON.parse(snapshot.text).logs.progress).toMatchObject([{
        attemptId: '01234567-89ab-cdef-0123-456789abcdef', stage: 'script-available', status: 'passed',
      }]);
    }
    for (const [, args, options] of mockExecaFn.mock.calls) {
      expect(options).toMatchObject({ timeout: 5000, maxBuffer: 16384, reject: false });
      expect(args).not.toContain('env');
    }
    expect(JSON.stringify(jest.mocked(logger.warn).mock.calls)).not.toContain('SECRET');
  });

  it('correlates the exited container to its actual immutable image and validated build revision', async () => {
    const imageId = `sha256:${'c'.repeat(64)}`;
    mockExecaFn.mockImplementation(async (_command, args, options) => {
      expect(options).toMatchObject({ timeout: 5000, maxBuffer: 16384, reject: false });
      if (args[0] === 'inspect' && String(args[2]).includes('NetworkSettings')) {
        return { exitCode: 0, stdout: 'awf-enclave-mcp-control\n', stderr: '' };
      }
      if (args[0] === 'inspect') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            status: 'exited', running: false, exitCode: 1, oomKilled: false, hasError: false, imageId,
          }),
          stderr: '',
        };
      }
      if (args[0] === 'image') {
        expect(args[4]).toBe(imageId);
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            imageId,
            repoDigests: [`ghcr.io/example/enclave@sha256:${'d'.repeat(64)}`],
            sourceRevision: 'e'.repeat(40),
          }),
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    await captureEnclaveStartupDiagnostics(getDir(), undefined, 'startup-failure');
    const snapshot = JSON.parse(snapshots()[0].text);
    expect(snapshot).toMatchObject({
      imageInspectStatus: 'captured',
      imageIdentity: {
        identityStatus: 'matched',
        containerImageId: imageId,
        inspectedImageId: imageId,
        repoDigests: [`sha256:${'d'.repeat(64)}`],
        sourceRevision: 'e'.repeat(40),
        sourceRevisionStatus: 'captured',
      },
    });
    expect(snapshot.imageIdentity).not.toHaveProperty('requestedImage');
    expect(JSON.stringify(snapshot)).not.toContain('ghcr.io');
  });

  it('records unavailable state and logs without leaking collection errors', async () => {
    mockExecaFn.mockRejectedValue(new Error(sensitive));
    await captureEnclaveStartupDiagnostics(getDir(), undefined, 'startup-failure');
    expect(JSON.parse(snapshots()[0].text)).toMatchObject({
      inspectStatus: 'unavailable', state: null, logsStatus: 'unavailable', logs: null,
    });
    expect(JSON.stringify(jest.mocked(logger.warn).mock.calls)).not.toContain('SECRET');
    expect(safeState('{"status":"SECRET","exitCode":99999,"Error":"SECRET"}'))
      .toMatchObject({ status: 'unknown', exitCode: null });
  });

  it('caps retention without deleting or overwriting earlier attempts', async () => {
    mockExecaFn.mockResolvedValue({ exitCode: 1, stdout: '', stderr: sensitive });
    for (let attempt = 0; attempt < 9; attempt++) {
      await captureEnclaveStartupDiagnostics(getDir(), undefined, 'startup-failure');
    }
    expect(snapshots()).toHaveLength(8);
    expect(mockExecaFn).toHaveBeenCalledTimes(16);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('retention limit'));
  });

  it('reports retention errors without masking the original startup failure', async () => {
    const logDir = path.join(getDir(), 'not-a-directory');
    fs.writeFileSync(logDir, 'occupied');
    await expect(captureEnclaveStartupDiagnostics(getDir(), logDir, 'startup-failure')).resolves.toBeUndefined();
    expect(mockExecaFn).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to retain'));
  });

  it('does not follow a symlink used as the diagnostic directory', async () => {
    const outside = path.join(getDir(), 'outside');
    const logDir = path.join(getDir(), 'logs');
    fs.mkdirSync(outside);
    fs.mkdirSync(logDir);
    fs.symlinkSync(outside, path.join(logDir, 'enclave-startup'));
    await captureEnclaveStartupDiagnostics(getDir(), logDir, 'startup-failure');
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(mockExecaFn).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to retain'));
  });
});
