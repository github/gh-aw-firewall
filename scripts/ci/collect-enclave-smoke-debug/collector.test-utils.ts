import * as fs from 'fs';
import * as path from 'path';
import { HostExecutorJournal } from '../../../src/enclave/host-executor-journal';

export { fs, path };
export { createHash } from 'crypto';
export { preservePublicEnclaveProxyDiagnostics } from '../../../src/enclave/proxy-debug-retention';
export { isSafeCopilotAuthLogFields, projectCopilotAuthLogFields } from '../../../src/enclave/proxy-auth-diagnostics';
export { preservePublicEnclaveArtifacts } from '../../../src/enclave/public-debug-artifacts';
export {
  HostExecutorJournal, persistHostExecutorProxyUsage, persistHostExecutorProxyResponseDiagnostics,
} from '../../../src/enclave/host-executor-journal';
export { resolveDockerEnclavePaths } from '../../../src/enclave/docker-lifecycle';
export { resolveDockerPublicEnclaveDebugPaths } from '../../../src/enclave/public-debug';
export { projectEnclaveSessionDiagnostics } from '../../../src/cloud-hypervisor/enclave-session-diagnostics';
export { schema as preflightSchema } from '../../../src/cloud-hypervisor/host-preflight-schema';

// eslint-disable-next-line @typescript-eslint/no-require-imports
export const collector = require('../collect-enclave-smoke-debug.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
export const mutableFs: typeof fs = require('node:fs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
export const live = require('../cloud-hypervisor-enclave-live-smoke');
export const { prepare, collect, MAX_STREAM_BYTES, MAX_FILES, projectDiagnostics, cliRoots } = collector;

export function stageCollector(root: string): string {
  const source = path.join(__dirname, '..', 'collect-enclave-smoke-debug.cjs');
  const target = path.join(root, 'collector.cjs');
  fs.copyFileSync(source, target);
  fs.chmodSync(target, 0o600);
  const library = path.join(root, 'collect-enclave-smoke-debug');
  fs.mkdirSync(library, { mode: 0o700 });
  for (const name of fs.readdirSync(path.join(__dirname)).filter(name => name.endsWith('.cjs'))) {
    const dependency = path.join(library, name);
    fs.copyFileSync(path.join(__dirname, name), dependency);
    fs.chmodSync(dependency, 0o600);
  }
  return target;
}

export function standaloneFixture() {
  let root: string;
  let scope: string;
  let roots: { journal: string; debug: string; backend: string };
  const uid = process.getuid!();
  const gid = process.getgid!();
  const runId = 'a'.repeat(32);
  const invocationId = 'b'.repeat(24);
  const identity = (runtime = roots.backend) => ({ runId, invocationId, entryId: 'script', runtime });
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(process.cwd(), '.enclave-debug-test-'));
    scope = path.join(root, 'scope');
    roots = { journal: path.join(root, 'journal'), debug: path.join(root, 'debug'), backend: 'cloud-hypervisor' };
    for (const directory of [roots.journal, roots.debug]) fs.mkdirSync(directory, { mode: 0o700 });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const prepareRun = () => prepare(scope, roots, uid, root);
  const collectRun = () => collect(scope, uid, gid, roots, uid, root);
  const write = (target: string, value: string | Buffer) => fs.writeFileSync(target, value, { mode: 0o600 });

  function envelope(overrides: Record<string, unknown> = {}) {
    return {
      version: 1, ...identity(), executorKind: 'script', stage: 'complete', failure: 'none', exitCode: 0,
      workloadStopped: true, workloadLaunched: true, stopProof: 'verified',
      stages: [{ stage: 'workload-exit', status: 'succeeded' }],
      streams: { stdout: 'captured', stderr: 'captured', session: 'not-applicable' },
      streamCoverage: {
        stdout: { artifactSource: roots.backend === 'docker' ? 'workload-file' : 'backend-stream', agentSession: 'unavailable' },
        stderr: { artifactSource: roots.backend === 'docker' ? 'workload-file' : 'backend-stream', agentSession: 'unavailable' },
        copilotDiagnostics: 'unavailable',
      },
      session: { status: 'not-applicable' },
      backendEvidence: {
        dockerInspect: roots.backend === 'docker'
          ? { status: 'captured', running: false, exitCode: 0, oomKilled: false } : { status: 'not-applicable' },
        vmCounters: { status: roots.backend === 'docker' ? 'not-applicable' : 'unavailable' },
        network: { status: 'unavailable' },
      },
      ...overrides,
    };
  }

  function invocation(value = envelope()) {
    const journal = new HostExecutorJournal({
      runId, journalDir: roots.journal, seedsDir: path.join(root, 'seeds'),
      invocationsDir: path.join(root, 'invocations'), entries: [],
    });
    journal.record({ invocationId, entryId: 'script', state: 'running' });
    journal.record({ invocationId, entryId: 'script', state: 'cleanup-pending' });
    journal.record({ invocationId, entryId: 'script', state: 'terminal', outcome: 'script-ok' });
    journal.record({ state: 'closed' });
    const source = path.join(roots.debug, runId, invocationId);
    fs.mkdirSync(source, { mode: 0o700, recursive: true });
    write(path.join(source, 'diagnostics.json'), JSON.stringify(value) + '\n');
    write(path.join(source, 'stdout.log'), value.streams.stdout === 'captured' ? 'public output\n' : '');
    write(path.join(source, 'stderr.log'), value.streams.stderr === 'captured' ? 'public error\n' : '');
    write(path.join(source, 'enclave-session.log'), '');
    return source;
  }
  return {
    get root() { return root; }, get scope() { return scope; }, get roots() { return roots; },
    uid, gid, runId, invocationId, identity, prepareRun, collectRun, write, envelope, invocation,
  };
}
