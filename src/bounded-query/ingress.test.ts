import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import execa from 'execa';
import type { WrapperConfig } from '../types';
import {
  removeSbxIngressCapabilityFile,
  resolveSbxIngress,
} from './ingress';
import { resolveBoundedQueryPaths } from './paths';

jest.mock('execa', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../services/host-gateway', () => ({
  resolveDockerHostGateway: jest.fn(() => '172.17.0.1'),
}));
const mockExeca = execa as unknown as jest.Mock;

describe('sbx bounded-query ingress resolution', () => {
  let workDir: string;
  let config: WrapperConfig;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-ingress-resolution-'));
    config = {
      workDir,
      boundedQueryIngressTransport: 'sbx-http',
    } as WrapperConfig;
    const paths = resolveBoundedQueryPaths(workDir);
    fs.mkdirSync(paths.controlDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(paths.capabilityPath, JSON.stringify({
      version: 1,
      query: 'a'.repeat(64),
      probe: 'b'.repeat(64),
    }), { mode: 0o600 });
    mockExeca.mockReset();
    mockExeca.mockResolvedValue({
      exitCode: 0,
      stdout: 'healthy|172.17.0.1:49152\n',
      stderr: '',
    });
  });

  afterEach(() => {
    const paths = resolveBoundedQueryPaths(workDir);
    fs.rmSync(paths.root, { recursive: true, force: true });
    fs.rmSync(paths.ingressRoot, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('returns only the endpoint, two capabilities, and agent-visible artifact paths', async () => {
    const result = await resolveSbxIngress(config);
    const paths = resolveBoundedQueryPaths(workDir);

    expect(result).toEqual({
      endpoint: 'http://host.docker.internal:49152/query',
      queryCapability: 'a'.repeat(64),
      probeCapability: 'b'.repeat(64),
      skillPath: paths.skillPath,
      wrapperDir: paths.agentDir,
    });
    const dockerArgs = mockExeca.mock.calls[0][1] as string[];
    expect(dockerArgs.join(' ')).not.toContain('a'.repeat(64));
    expect(dockerArgs.join(' ')).not.toContain('b'.repeat(64));
  });

  it.each([
    '0.0.0.0:49152',
    '[::1]:49152',
    '172.17.0.1:0',
    '172.17.0.1:70000',
    '',
  ])('rejects a broad or malformed publication: %s', async (published) => {
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: `healthy|${published}`, stderr: '' });
    await expect(resolveSbxIngress(config)).rejects.toThrow(/narrowly published/);
  });

  it('waits for broker health before returning the endpoint', async () => {
    mockExeca
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'starting|', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'healthy|172.17.0.1:49152', stderr: '' });

    const result = await resolveSbxIngress(config);
    expect(result.endpoint).toBe('http://host.docker.internal:49152/query');
    expect(mockExeca.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('removes the private capability file after broker startup and sbx probing', () => {
    const capabilityPath = resolveBoundedQueryPaths(workDir).capabilityPath;
    expect(fs.existsSync(capabilityPath)).toBe(true);
    removeSbxIngressCapabilityFile(config);
    expect(fs.existsSync(capabilityPath)).toBe(false);
  });
});
