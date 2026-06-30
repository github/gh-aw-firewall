import { resolveDockerHostGateway } from './host-gateway';

// Mock execa module
const mockExecaSync = jest.fn();
jest.mock('execa', () => {
  const fn = (...args: any[]) => fn.sync(...args);
  fn.sync = (...args: any[]) => mockExecaSync(...args);
  return fn;
});

describe('resolveDockerHostGateway', () => {
  beforeEach(() => {
    mockExecaSync.mockReset();
  });

  it('should return bridge gateway IP when docker network inspect succeeds', () => {
    mockExecaSync.mockReturnValueOnce({ stdout: '172.17.0.1' });

    expect(resolveDockerHostGateway()).toBe('172.17.0.1');
    expect(mockExecaSync).toHaveBeenCalledWith(
      'docker',
      ['network', 'inspect', 'bridge', '-f', '{{(index .IPAM.Config 0).Gateway}}'],
      expect.objectContaining({ timeout: 5000 }),
    );
  });

  it('should fall back to ip route when docker inspect fails', () => {
    mockExecaSync
      .mockImplementationOnce(() => { throw new Error('docker not available'); })
      .mockReturnValueOnce({ stdout: '1.1.1.1 via 10.0.0.1 dev eth0 src 192.168.1.50 uid 1000' });

    expect(resolveDockerHostGateway()).toBe('192.168.1.50');
  });

  it('should return undefined when all methods fail', () => {
    mockExecaSync.mockImplementation(() => { throw new Error('command failed'); });

    expect(resolveDockerHostGateway()).toBeUndefined();
  });

  it('should skip invalid IPs from docker inspect and try fallback', () => {
    mockExecaSync
      .mockReturnValueOnce({ stdout: 'not-an-ip' })
      .mockReturnValueOnce({ stdout: '1.1.1.1 via 10.0.0.1 dev eth0 src 10.0.0.5 uid 1000' });

    expect(resolveDockerHostGateway()).toBe('10.0.0.5');
  });

  it('should trim whitespace from docker inspect output', () => {
    mockExecaSync.mockReturnValueOnce({ stdout: '  172.17.0.1\n' });

    expect(resolveDockerHostGateway()).toBe('172.17.0.1');
  });
});
