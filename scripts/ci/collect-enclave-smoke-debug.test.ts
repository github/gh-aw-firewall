import {
  fs, path, collector, cliRoots, stageCollector, resolveDockerEnclavePaths,
  resolveDockerPublicEnclaveDebugPaths, isSafeCopilotAuthLogFields, projectCopilotAuthLogFields,
} from './collect-enclave-smoke-debug/collector.test-utils';
import { execFileSync } from 'child_process';

describe('public enclave collector facade compatibility', () => {
  let root: string;
  const uid = process.getuid!();
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(process.cwd(), '.enclave-debug-test-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('has fixed backend roots and loads without the AWF package', () => {
    expect(cliRoots('docker', 1001).journal).toBe('/var/lib/awf/enclave-storage/1001/host-state/host-executor-journal');
    expect(collector.cliCandidates('docker', 1001)).toEqual([
      { backend: 'docker', sourceUid: 1001,
        journal: '/var/lib/awf/enclave-storage/1001/host-state/host-executor-journal',
        debug: '/var/lib/awf/enclave-storage/1001/host-state/debug-artifacts/docker' },
      { backend: 'docker', sourceUid: 0, journal: '/var/lib/awf-cloud-hypervisor/host-executor-journal',
        debug: '/var/lib/awf-cloud-hypervisor/debug-artifacts/docker' },
    ]);
    const producerPaths = resolveDockerEnclavePaths(path.join(root, 'work'));
    const producerDebug = resolveDockerPublicEnclaveDebugPaths();
    expect(collector.cliCandidates('docker', uid)).toEqual(expect.arrayContaining([
      expect.objectContaining({ journal: producerPaths.hostExecutorJournalDir, debug: producerDebug.root }),
    ]));
    expect(cliRoots('cloud-hypervisor', 1001).debug).toBe('/var/lib/awf-cloud-hypervisor/debug-artifacts/cloud-hypervisor');
    const stagedPath = stageCollector(root);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const staged = require(stagedPath);
    for (const value of [projectCopilotAuthLogFields({}), '', 'credential_source=PRIVATE']) {
      expect(staged.isSafeCopilotAuthLogFields(value)).toBe(isSafeCopilotAuthLogFields(value));
    }
    expect(fs.readdirSync(path.join(root, 'collect-enclave-smoke-debug')).every(name => name.endsWith('.cjs'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'dist'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'node_modules'))).toBe(false);
    const library = path.join(root, 'collect-enclave-smoke-debug');
    expect(fs.statSync(library).mode & 0o7777).toBe(0o700);
    for (const name of ['collector.cjs', ...fs.readdirSync(library).map(name => `collect-enclave-smoke-debug/${name}`)]) {
      const stat = fs.statSync(path.join(root, name));
      expect(stat.mode & 0o7777).toBe(0o600);
      expect(stat.uid).toBe(uid);
    }
  });

  it('loads the protected deployment tree with only built-ins and sibling modules available', () => {
    const stagedPath = stageCollector(root);
    const output = execFileSync(process.execPath, ['-e', `
      const Module = require('node:module');
      const path = require('node:path');
      const entry = process.argv[1];
      const library = path.join(path.dirname(entry), 'collect-enclave-smoke-debug');
      const load = Module._load;
      Module._load = function(request, parent, isMain) {
        if (!Module.isBuiltin(request)) {
          const resolved = Module._resolveFilename(request, parent);
          if (resolved !== entry && !resolved.startsWith(library + path.sep)) {
            throw new Error('Unexpected deployment dependency');
          }
        }
        return load.call(this, request, parent, isMain);
      };
      process.stdout.write(JSON.stringify(Object.keys(require(entry))));
    `, stagedPath], { encoding: 'utf8' });
    expect(JSON.parse(output)).toEqual(Object.keys(collector));
  });

  it('preserves the exact exported facade key set and module identities', () => {
    expect(Object.keys(collector)).toEqual([
      'prepare', 'collect', 'retainStartup', 'projectStartup', 'retainFinalization', 'projectFinalization',
      'FINALIZATION_REASONS', 'RESULT_CODES', 'projectStartupChecklist', 'MAX_STREAM_BYTES', 'MAX_FILES',
      'MAX_PUBLISHED_FILES', 'MAX_PUBLISHED_BYTES', 'MAX_STATUS_BYTES', 'MAX_STARTUP_BYTES', 'directory',
      'inventory', 'readRegular', 'projectProxyUsage', 'projectProxyResponse', 'projectProxyEvents',
      'projectProxyContainerLog', 'isSafeCopilotAuthLogFields', 'projectDiagnostics', 'cliRoots',
      'cliCandidates', 'parseArguments', 'main', 'publishCollectionFailure', 'assertPublicationBounds', 'redactCredentials',
    ]);
    for (const name of ['common', 'safe-fs', 'redaction', 'projections', 'publication']) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const dependency = require(`./collect-enclave-smoke-debug/${name}.cjs`);
      for (const [key, value] of Object.entries(dependency)) {
        if (Object.prototype.hasOwnProperty.call(collector, key)) expect(collector[key]).toBe(value);
      }
    }
  });

  it('supports historical CH-only CLI callers without weakening the explicit backend/runner interface', () => {
    expect(collector.parseArguments(['prepare', '123-1'])).toEqual({
      operation: 'prepare', backend: 'cloud-hypervisor', key: '123-1',
      runnerUid: 0, runnerGid: 0, binding: { backend: 'cloud-hypervisor', legacy: true },
    });
    expect(collector.parseArguments(['collect', '123-1', '1001', '1002'])).toEqual({
      operation: 'collect', backend: 'cloud-hypervisor', key: '123-1',
      runnerUid: 1001, runnerGid: 1002, binding: { backend: 'cloud-hypervisor', legacy: true },
    });
    expect(collector.parseArguments(['prepare', 'docker', '123-1', '1001', '1002'])).toEqual({
      operation: 'prepare', backend: 'docker', key: '123-1', runnerUid: 1001, runnerGid: 1002,
      binding: { backend: 'docker', runnerUid: 1001, runnerGid: 1002 },
    });
  });

  it.each([
    ['prepare', 'docker'],
    ['collect', 'docker', '1001', '1002'],
    ['prepare', 'docker', '123-1'],
    ['prepare', 'other', '123-1', '1001', '1002'],
    ['prepare', 'docker', '../../escape', '1001', '1002'],
    ['collect', '123-1', '-1', '1002'],
    ['collect', '123-1', '4294967295', '1002'],
    ['collect', 'cloud-hypervisor', '123-1', '1001', '1002', '/caller/root'],
  ])('rejects unsupported or unsafe CLI arguments %j', (...args: string[]) => {
    expect(() => collector.parseArguments(args)).toThrow(/cli-arguments/);
  });
});
