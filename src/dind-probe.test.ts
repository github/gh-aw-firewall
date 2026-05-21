import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import execa from 'execa';
import { probeSplitFilesystem } from './dind-probe';

jest.mock('execa');
jest.mock('./docker-host', () => ({
  getLocalDockerEnv: () => ({ ...process.env }),
}));

const mockedExeca = execa as jest.MockedFunction<typeof execa>;

describe('probeSplitFilesystem', () => {
  let probeDir: string;

  beforeEach(() => {
    probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-probe-test-'));
    jest.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(probeDir, { recursive: true, force: true });
  });

  /** Helper: mock docker info (connectivity check) as successful */
  function mockDockerReachable() {
    mockedExeca.mockResolvedValueOnce({ exitCode: 0 } as any);
  }

  /** Helper: mock docker info as unreachable */
  function mockDockerUnreachable() {
    mockedExeca.mockResolvedValueOnce({ exitCode: 1 } as any);
  }

  it('returns no prefix when daemon can see runner filesystem directly', async () => {
    mockDockerReachable();
    // Direct mount succeeds (exit code 0)
    mockedExeca.mockResolvedValueOnce({ exitCode: 0 } as any);

    const result = await probeSplitFilesystem(probeDir);

    expect(result.prefix).toBeUndefined();
    expect(result.splitDetected).toBe(false);
    expect(result.inconclusive).toBe(false);
    // 1 docker info + 1 probe
    expect(mockedExeca).toHaveBeenCalledTimes(2);
  });

  it('returns /host when direct mount fails but /host prefix works', async () => {
    mockDockerReachable();
    // Direct mount: file not found (exit code 1)
    mockedExeca.mockResolvedValueOnce({ exitCode: 1 } as any);
    // /host prefix succeeds
    mockedExeca.mockResolvedValueOnce({ exitCode: 0 } as any);

    const result = await probeSplitFilesystem(probeDir);

    expect(result.prefix).toBe('/host');
    expect(result.splitDetected).toBe(true);
    expect(result.inconclusive).toBe(false);
    // 1 docker info + 1 direct + 1 /host
    expect(mockedExeca).toHaveBeenCalledTimes(3);
    // Verify /host call uses prefixed path
    const hostCallArgs = mockedExeca.mock.calls[2][1] as string[];
    expect(hostCallArgs).toContain(`/host${probeDir}:/probe:ro`);
  });

  it('returns /runner when /host fails but /runner prefix works', async () => {
    mockDockerReachable();
    // Direct mount: file not found
    mockedExeca.mockResolvedValueOnce({ exitCode: 1 } as any);
    // /host prefix: file not found
    mockedExeca.mockResolvedValueOnce({ exitCode: 1 } as any);
    // /runner prefix succeeds
    mockedExeca.mockResolvedValueOnce({ exitCode: 0 } as any);

    const result = await probeSplitFilesystem(probeDir);

    expect(result.prefix).toBe('/runner');
    expect(result.splitDetected).toBe(true);
    expect(result.inconclusive).toBe(false);
    // 1 docker info + 3 probes
    expect(mockedExeca).toHaveBeenCalledTimes(4);
  });

  it('returns splitDetected=true when no candidate prefix works', async () => {
    mockDockerReachable();
    // Direct mount: file not found
    mockedExeca.mockResolvedValueOnce({ exitCode: 1 } as any);
    // /host prefix: file not found
    mockedExeca.mockResolvedValueOnce({ exitCode: 1 } as any);
    // /runner prefix: file not found
    mockedExeca.mockResolvedValueOnce({ exitCode: 1 } as any);

    const result = await probeSplitFilesystem(probeDir);

    expect(result.prefix).toBeUndefined();
    expect(result.splitDetected).toBe(true);
    expect(result.inconclusive).toBe(false);
  });

  it('returns inconclusive when Docker daemon is unreachable (fail-fast)', async () => {
    mockDockerUnreachable();

    const result = await probeSplitFilesystem(probeDir);

    expect(result.prefix).toBeUndefined();
    expect(result.splitDetected).toBe(false);
    expect(result.inconclusive).toBe(true);
    // Only 1 call (docker info) — no probe attempts
    expect(mockedExeca).toHaveBeenCalledTimes(1);
  });

  it('returns inconclusive when docker info times out', async () => {
    mockedExeca.mockRejectedValueOnce(new Error('timed out'));

    const result = await probeSplitFilesystem(probeDir);

    expect(result.prefix).toBeUndefined();
    expect(result.splitDetected).toBe(false);
    expect(result.inconclusive).toBe(true);
    expect(mockedExeca).toHaveBeenCalledTimes(1);
  });

  it('returns inconclusive when direct probe gets infrastructure error (exit 125)', async () => {
    mockDockerReachable();
    // Direct mount: infrastructure error (e.g., image pull failure)
    mockedExeca.mockResolvedValueOnce({ exitCode: 125 } as any);

    const result = await probeSplitFilesystem(probeDir);

    expect(result.prefix).toBeUndefined();
    expect(result.splitDetected).toBe(false);
    expect(result.inconclusive).toBe(true);
    // Stops after infra error — doesn't try prefixes
    expect(mockedExeca).toHaveBeenCalledTimes(2);
  });

  it('returns inconclusive when direct probe throws (timeout/ENOENT)', async () => {
    mockDockerReachable();
    // Direct mount throws (e.g., execa timeout)
    mockedExeca.mockRejectedValueOnce(new Error('ETIMEDOUT'));

    const result = await probeSplitFilesystem(probeDir);

    expect(result.prefix).toBeUndefined();
    expect(result.splitDetected).toBe(false);
    expect(result.inconclusive).toBe(true);
    expect(mockedExeca).toHaveBeenCalledTimes(2);
  });

  it('handles error during probe setup gracefully', async () => {
    // Use a temp dir, then remove write permissions to force writeFileSync to fail
    const restrictedDir = path.join(probeDir, 'restricted');
    fs.mkdirSync(restrictedDir);
    fs.chmodSync(restrictedDir, 0o444);

    const result = await probeSplitFilesystem(path.join(restrictedDir, 'sub'));

    expect(result.prefix).toBeUndefined();
    expect(result.splitDetected).toBe(false);
    expect(result.inconclusive).toBe(true);

    // Restore permissions for cleanup
    fs.chmodSync(restrictedDir, 0o755);
  });

  it('cleans up sentinel file after successful probe', async () => {
    mockDockerReachable();
    mockedExeca.mockResolvedValueOnce({ exitCode: 0 } as any);

    await probeSplitFilesystem(probeDir);

    const files = fs.readdirSync(probeDir).filter(f => f.startsWith('.awf-fs-probe-'));
    expect(files).toHaveLength(0);
  });

  it('cleans up sentinel file after failed probe', async () => {
    mockDockerReachable();
    mockedExeca.mockResolvedValueOnce({ exitCode: 1 } as any);
    mockedExeca.mockResolvedValueOnce({ exitCode: 1 } as any);
    mockedExeca.mockResolvedValueOnce({ exitCode: 1 } as any);

    await probeSplitFilesystem(probeDir);

    const files = fs.readdirSync(probeDir).filter(f => f.startsWith('.awf-fs-probe-'));
    expect(files).toHaveLength(0);
  });

  it('uses busybox image for the probe', async () => {
    mockDockerReachable();
    mockedExeca.mockResolvedValueOnce({ exitCode: 0 } as any);

    await probeSplitFilesystem(probeDir);

    // Second call is the actual probe (first is docker info)
    const callArgs = mockedExeca.mock.calls[1][1] as string[];
    expect(callArgs).toContain('busybox:latest');
  });

  it('uses 10s timeout for probe and 5s for connectivity check', async () => {
    mockDockerReachable();
    mockedExeca.mockResolvedValueOnce({ exitCode: 0 } as any);

    await probeSplitFilesystem(probeDir);

    // First call: docker info (5s timeout)
    const infoOptions = (mockedExeca.mock.calls[0] as any)[2];
    expect(infoOptions.timeout).toBe(5000);
    // Second call: probe (10s timeout)
    const probeOptions = (mockedExeca.mock.calls[1] as any)[2];
    expect(probeOptions.timeout).toBe(10000);
    expect(probeOptions.reject).toBe(false);
  });
});

