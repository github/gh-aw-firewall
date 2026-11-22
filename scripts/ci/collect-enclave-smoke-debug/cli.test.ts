import { fs, path, collector, mutableFs } from './collector.test-utils';

describe('public enclave diagnostics CLI dispatcher', () => {
  let root: string;
  let exportRoot: string;
  let candidates: Array<{
    backend: string; sourceUid: number; journal: string; debug: string; trustedRoot: string;
  }>;
  let sourceRoots: string[];
  let openedPaths: Map<number, string>;
  const privilegedUid = process.getuid!();
  const privilegedGid = process.getgid!();
  const runnerUid = privilegedUid < 0xfffffffe ? privilegedUid + 1 : privilegedUid - 1;
  const runnerGid = privilegedGid < 0xfffffffe ? privilegedGid + 1 : privilegedGid - 1;
  const key = '123456789-1';
  const runId = 'c'.repeat(32);
  const invocationId = 'd'.repeat(24);
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(process.cwd(), '.enclave-dispatcher-test-'));
    exportRoot = path.join(root, 'export');
    fs.mkdirSync(exportRoot, { mode: 0o711 });
    openedPaths = new Map();
    sourceRoots = [0, 1].map(() => fs.mkdtempSync(path.join(process.cwd(), '.enclave-source-test-')));
    candidates = sourceRoots.map((sourceRoot, index) => {
      const journal = path.join(sourceRoot, 'journal');
      const debug = path.join(sourceRoot, 'debug');
      fs.mkdirSync(journal, { mode: 0o700 });
      fs.mkdirSync(debug, { mode: 0o700 });
      return {
        backend: 'docker', sourceUid: index === 0 ? runnerUid : privilegedUid, journal, debug, trustedRoot: sourceRoot,
      };
    });
    const actualLstatSync = mutableFs.lstatSync.bind(mutableFs);
    jest.spyOn(mutableFs, 'lstatSync').mockImplementation(((target: fs.PathLike) => {
      const stat = actualLstatSync(target);
      const targetPath = path.resolve(target.toString());
      const sourceIndex = sourceRoots.findIndex(sourceRoot => targetPath === sourceRoot
        || targetPath.startsWith(`${sourceRoot}${path.sep}`));
      if (sourceIndex === -1) return stat;
      const ownedStat = Object.assign(Object.create(Object.getPrototypeOf(stat)), stat);
      Object.defineProperty(ownedStat, 'uid', {
        value: sourceIndex === 0 ? runnerUid : privilegedUid, configurable: true, enumerable: true,
      });
      return ownedStat;
    }) as typeof fs.lstatSync);
    const actualOpenSync = mutableFs.openSync.bind(mutableFs);
    jest.spyOn(mutableFs, 'openSync').mockImplementation(((
      target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode,
    ) => {
      const fd = actualOpenSync(target, flags, mode);
      openedPaths.set(fd, path.resolve(target.toString()));
      return fd;
    }) as typeof fs.openSync);
    const actualFstatSync = mutableFs.fstatSync.bind(mutableFs);
    jest.spyOn(mutableFs, 'fstatSync').mockImplementation(((fd: number) => {
      const stat = actualFstatSync(fd);
      const targetPath = openedPaths.get(fd);
      if (targetPath === undefined) return stat;
      const sourceIndex = sourceRoots.findIndex(sourceRoot => targetPath === sourceRoot
        || targetPath.startsWith(`${sourceRoot}${path.sep}`));
      if (sourceIndex === -1) return stat;
      const ownedStat = Object.assign(Object.create(Object.getPrototypeOf(stat)), stat);
      Object.defineProperty(ownedStat, 'uid', {
        value: sourceIndex === 0 ? runnerUid : privilegedUid, configurable: true, enumerable: true,
      });
      return ownedStat;
    }) as typeof fs.fstatSync);
    jest.spyOn(mutableFs, 'chownSync').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
    for (const sourceRoot of sourceRoots) fs.rmSync(sourceRoot, { recursive: true, force: true });
  });
  const options = () => ({
    privilegedUid, exportRoot, exportTrustedRoot: root, candidatesForBackend: () => candidates,
  });
  const args = (operation: string, uid = runnerUid, backend = 'docker') =>
    [operation, backend, key, String(uid), String(runnerGid)];
  function active(candidate: typeof candidates[number]) {
    const invocationRoot = path.join(candidate.debug, runId, invocationId);
    fs.mkdirSync(invocationRoot, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(candidate.journal, `${runId}.journal`), [
      JSON.stringify({ version: 1, runId, state: 'open' }),
      JSON.stringify({ runId, invocationId, entryId: 'script', state: 'terminal', outcome: 'success' }),
    ].join('\n') + '\n', { mode: 0o600 });
    fs.writeFileSync(path.join(invocationRoot, 'diagnostics.json'), JSON.stringify({
      version: 1, runId, invocationId, entryId: 'script', runtime: 'docker', executorKind: 'script',
      stage: 'complete', failure: 'none', exitCode: 0, workloadStopped: true, workloadLaunched: true,
      stopProof: 'verified', stages: [],
      streams: { stdout: 'unavailable', stderr: 'unavailable', session: 'not-applicable' },
      streamCoverage: {
        stdout: { artifactSource: 'unavailable', agentSession: 'unavailable' },
        stderr: { artifactSource: 'unavailable', agentSession: 'unavailable' },
        copilotDiagnostics: 'unavailable',
      },
      session: { status: 'not-applicable' },
      backendEvidence: {
        dockerInspect: { status: 'captured', running: false, exitCode: 0, oomKilled: false },
        vmCounters: { status: 'not-applicable' }, network: { status: 'unavailable' },
      },
    }) + '\n', { mode: 0o600 });
  }
  it.each([0, 1])('dispatches and validates the Docker storage layout %i with separate identities', layout => {
    expect(runnerUid).not.toBe(privilegedUid);
    expect(collector.main(args('prepare'), options())).toBe(0);
    active(candidates[layout]);
    expect(collector.main(args('collect'), options())).toBe(0);
    const runDirectory = path.join(exportRoot, key);
    const upload = path.join(runDirectory, 'upload');
    expect(fs.readdirSync(upload).sort()).toEqual(['collection-status.txt', 'diagnostics.json']);
    expect(fs.statSync(runDirectory).uid).toBe(privilegedUid);
    expect(fs.statSync(upload).mode & 0o7777).toBe(0o700);
    expect(fs.statSync(path.join(upload, 'diagnostics.json')).mode & 0o7777).toBe(0o600);
    expect((mutableFs.chownSync as unknown as jest.Mock).mock.calls)
      .toContainEqual([path.join(runDirectory, 'pending', 'diagnostics.json'), runnerUid, runnerGid]);
  });
  it.each([
    { backend: 'cloud-hypervisor', uid: runnerUid },
    { backend: 'docker', uid: runnerUid + 1 },
  ])('rejects a collect invocation with mismatched prepared binding %j', binding => {
    expect(collector.main(args('prepare'), options())).toBe(0);
    active(candidates[0]);
    expect(() => collector.main(args('collect', binding.uid, binding.backend), options())).toThrow(/prepared-scope/);
    expect(fs.existsSync(path.join(exportRoot, key, 'upload'))).toBe(false);
  });
  it('rejects simultaneous activity in both Docker layouts without exporting either source', () => {
    expect(collector.main(args('prepare'), options())).toBe(0);
    for (const candidate of candidates) active(candidate);
    expect(collector.main(args('collect'), options())).toBe(1);
    const upload = path.join(exportRoot, key, 'upload');
    expect(fs.readdirSync(upload)).toEqual(['collection-status.txt']);
    expect(fs.readFileSync(path.join(upload, 'collection-status.txt'), 'utf8'))
      .toContain('failedCheck=run-budget category=concurrent-runs');
  });
});
