import { setupHostIptables, __testing } from './host-iptables';
import execa from 'execa';

// Mock execa
jest.mock('execa');
const mockedExeca = execa as jest.MockedFunction<typeof execa>;

// Mock getLocalDockerEnv to return a predictable env for assertions
jest.mock('./docker-manager', () => ({
  getLocalDockerEnv: () => process.env,
}));

// Mock logger to avoid console output during tests
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('./logger', () => require('./test-helpers/mock-logger.test-utils').loggerMockFactory());

describe('host-iptables', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __testing._resetIpv6State();
  });

  describe('setupHostIptables with DoH proxy', () => {
    it('should add HTTPS ACCEPT rule for DoH proxy when dohProxyIp is provided', async () => {
      mockedExeca
        // Mock getNetworkBridgeName
        .mockResolvedValueOnce({ stdout: 'fw-bridge', stderr: '', exitCode: 0 } as any)
        // Mock iptables -L DOCKER-USER (permission check)
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any)
        // Mock chain existence check (doesn't exist)
        .mockResolvedValueOnce({ exitCode: 1 } as any);

      // Mock all subsequent iptables calls
      mockedExeca.mockResolvedValue({
        stdout: 'Chain DOCKER-USER\nChain FW_WRAPPER',
        stderr: '',
        exitCode: 0,
      } as any);

      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '8.8.4.4'], undefined, '172.30.0.40');

      // Verify HTTPS ACCEPT rule for DoH proxy
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-s', '172.30.0.40', '-p', 'tcp', '--dport', '443',
        '-j', 'ACCEPT',
      ]);

      // Verify DNS ACCEPT rules for DoH proxy
      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'udp', '-d', '172.30.0.40', '--dport', '53',
        '-j', 'ACCEPT',
      ]);

      expect(mockedExeca).toHaveBeenCalledWith('iptables', [
        '-t', 'filter', '-A', 'FW_WRAPPER',
        '-p', 'tcp', '-d', '172.30.0.40', '--dport', '53',
        '-j', 'ACCEPT',
      ]);
    });

    it('should not add DoH rules when dohProxyIp is not provided', async () => {
      mockedExeca
        .mockResolvedValueOnce({ stdout: 'fw-bridge', stderr: '', exitCode: 0 } as any)
        .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any)
        .mockResolvedValueOnce({ exitCode: 1 } as any);

      mockedExeca.mockResolvedValue({
        stdout: 'Chain DOCKER-USER\nChain FW_WRAPPER',
        stderr: '',
        exitCode: 0,
      } as any);

      await setupHostIptables('172.30.0.10', 3128, ['8.8.8.8', '8.8.4.4']);

      // Verify no DoH proxy rules were added
      expect(mockedExeca).not.toHaveBeenCalledWith('iptables', expect.arrayContaining([
        '-s', '172.30.0.40',
      ]));
    });
  });
});
