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

  it('returns no prefix when daemon can see runner filesystem directly', async () => {
    // Direct mount succeeds (exit code 0)
    mockedExeca.mockResolvedValueOnce({ exitCode: 0 } as any);

    const result = await probeSplitFilesystem(probeDir);

    expect(result.prefix).toBeUndefined();
    expect(result.splitDetected).toBe(false);
    expect(mockedExeca).toHaveBeenCalledTimes(1);
    // Verify the mount source is the probeDir (no prefix)
    const callArgs = mockedExeca.mock.calls[0][1] as string[];
    expect(callArgs).toContain(`${probeDir}:/probe:ro`);
  });

  it('returns /host when direct mount fails but /host prefix works', async () => {
    // Direct mount fails
    mockedExeca.mockResolvedValueOnce({ exitCode: 1 } as any);
    // /host prefix succeeds
    mockedExeca.mockResolvedValueOnce({ exitCode: 0 } as any);

    const result = await probeSplitFilesystem(probeDir);

    expect(result.prefix).toBe('/host');
    expect(result.splitDetected).toBe(true);
    expect(mockedExeca).toHaveBeenCalledTimes(2);
    // Verify second call uses /host prefix
    const secondCallArgs = mockedExeca.mock.calls[1][1] as string[];
    expect(secondCallArgs).toContain(`/host${probeDir}:/probe:ro`);
  });

  it('returns /runner when /host fails but /runner prefix works', async () => {
    // Direct mount fails
    mockedExeca.mockResolvedValueOnce({ exitCode: 1 } as any);
    // /host prefix fails
    mockedExeca.mockResolvedValueOnce({ exitCode: 1 } as any);
    // /runner prefix succeeds
    mockedExeca.mockResolvedValueOnce({ exitCode: 0 } as any);

    const result = await probeSplitFilesystem(probeDir);

    expect(result.prefix).toBe('/runner');
    expect(result.splitDetected).toBe(true);
    expect(mockedExeca).toHaveBeenCalledTimes(3);
  });

  it('returns undefined with splitDetected=true when no candidate works', async () => {
    // Direct mount fails
    mockedExeca.mockResolvedValueOnce({ exitCode: 1 } as any);
    // /host prefix fails
    mockedExeca.mockResolvedValueOnce({ exitCode: 1 } as any);
    // /runner prefix fails
    mockedExeca.mockResolvedValueOnce({ exitCode: 1 } as any);

    const result = await probeSplitFilesystem(probeDir);

    expect(result.prefix).toBeUndefined();
    expect(result.splitDetected).toBe(true);
    expect(mockedExeca).toHaveBeenCalledTimes(3);
  });

  it('handles timeout gracefully', async () => {
    // Direct mount times out
    mockedExeca.mockRejectedValueOnce(new Error('timed out'));

    const result = await probeSplitFilesystem(probeDir);

    // Timeout on direct probe means we can't determine — treat as not split
    // because the probe function catches errors in runProbe and returns false
    // Then it tries /host and /runner candidates
    expect(result.splitDetected).toBe(true);
  });

  it('handles error during probe setup gracefully', async () => {
    // Use a non-existent directory that can't be created
    const badDir = '/proc/nonexistent/probe-dir';
    
    const result = await probeSplitFilesystem(badDir);

    expect(result.prefix).toBeUndefined();
    expect(result.splitDetected).toBe(false);
  });

  it('cleans up sentinel file after successful probe', async () => {
    mockedExeca.mockResolvedValueOnce({ exitCode: 0 } as any);

    await probeSplitFilesystem(probeDir);

    // Sentinel should be cleaned up
    const files = fs.readdirSync(probeDir).filter(f => f.startsWith('.awf-fs-probe-'));
    expect(files).toHaveLength(0);
  });

  it('cleans up sentinel file after failed probe', async () => {
    mockedExeca.mockResolvedValueOnce({ exitCode: 1 } as any);
    mockedExeca.mockResolvedValueOnce({ exitCode: 1 } as any);
    mockedExeca.mockResolvedValueOnce({ exitCode: 1 } as any);

    await probeSplitFilesystem(probeDir);

    const files = fs.readdirSync(probeDir).filter(f => f.startsWith('.awf-fs-probe-'));
    expect(files).toHaveLength(0);
  });

  it('uses busybox image for the probe', async () => {
    mockedExeca.mockResolvedValueOnce({ exitCode: 0 } as any);

    await probeSplitFilesystem(probeDir);

    const callArgs = mockedExeca.mock.calls[0][1] as string[];
    expect(callArgs).toContain('busybox:latest');
  });

  it('passes timeout option to execa', async () => {
    mockedExeca.mockResolvedValueOnce({ exitCode: 0 } as any);

    await probeSplitFilesystem(probeDir);

    const callOptions = (mockedExeca.mock.calls[0] as any)[2];
    expect(callOptions.timeout).toBe(15000);
    expect(callOptions.reject).toBe(false);
  });
});
