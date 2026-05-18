import { execaResult, mockedExeca } from './test-helpers/host-iptables-test-setup';
import { cleanupChain } from './host-iptables-shared';

describe('host-iptables-shared', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('cleanupChain', () => {
    it('removes matching DOCKER-USER references in reverse order before deleting the chain', async () => {
      mockedExeca.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'iptables' && args.includes('DOCKER-USER') && args.includes('--line-numbers')) {
          return Promise.resolve(execaResult({
            stdout: '1 FW_WRAPPER all -- 0.0.0.0/0 0.0.0.0/0\n3 FW_WRAPPER all -- 0.0.0.0/0 0.0.0.0/0\n',
          }));
        }
        return Promise.resolve(execaResult());
      }) as any);

      await cleanupChain('iptables', 'FW_WRAPPER');

      expect(mockedExeca).toHaveBeenCalledWith('iptables', ['-t', 'filter', '-D', 'DOCKER-USER', '3'], { reject: false });
      expect(mockedExeca).toHaveBeenCalledWith('iptables', ['-t', 'filter', '-D', 'DOCKER-USER', '1'], { reject: false });
      expect(mockedExeca).toHaveBeenCalledWith('iptables', ['-t', 'filter', '-F', 'FW_WRAPPER'], { reject: false });
      expect(mockedExeca).toHaveBeenCalledWith('iptables', ['-t', 'filter', '-X', 'FW_WRAPPER'], { reject: false });
    });

    it('skips DOCKER-USER reference removal when configured', async () => {
      mockedExeca.mockResolvedValue(execaResult());

      await cleanupChain('ip6tables', 'FW_WRAPPER_V6', { removeDockerUserReferences: false });

      expect(mockedExeca).not.toHaveBeenCalledWith('ip6tables', [
        '-t', 'filter', '-L', 'DOCKER-USER', '-n', '--line-numbers',
      ], { reject: false });
      expect(mockedExeca).toHaveBeenCalledWith('ip6tables', ['-t', 'filter', '-F', 'FW_WRAPPER_V6'], { reject: false });
      expect(mockedExeca).toHaveBeenCalledWith('ip6tables', ['-t', 'filter', '-X', 'FW_WRAPPER_V6'], { reject: false });
    });
  });
});
