import { createSandbox, removeSandbox } from './sbx-manager';
import { mockExecaFn } from './test-helpers/mock-execa.test-utils';
import { logger } from './logger';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('./logger', () => require('./test-helpers/mock-logger.test-utils').loggerMockFactory());

const mockedLogger = jest.mocked(logger);

describe('sbx-manager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('createSandbox', () => {
    it('uses shell agent, configured mounts, and sanitized env', async () => {
      mockExecaFn
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // auth check
        .mockResolvedValueOnce({ exitCode: 0, stdout: 'Created sandbox', stderr: '' }); // sbx create

      await createSandbox({
        name: 'awf-agent-test',
        workspaceDir: '/workspace',
        squidIp: '172.30.0.10',
        extraMounts: ['/tmp/gh-aw:/tmp/gh-aw:ro'],
      });

      expect(mockExecaFn).toHaveBeenCalledWith('sbx', [
        'create',
        '--name', 'awf-agent-test',
        'shell',
        '/workspace',
        '/tmp/gh-aw:ro',
        '/tmp',
        '/usr/local/bin',
        process.env.HOME || '/home/runner',
      ], expect.objectContaining({
        input: 'y\n',
        env: expect.not.objectContaining({
          XDG_CONFIG_HOME: expect.anything(),
          DOCKER_SANDBOXES_PROXY: expect.anything(),
        }),
      }));
    });
  });

  describe('removeSandbox', () => {
    it('warns when sbx rm exits non-zero', async () => {
      mockExecaFn
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // stop
        .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'still running' }); // rm

      await removeSandbox('awf-agent-test');

      expect(mockedLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to remove sandbox "awf-agent-test"'),
      );
    });
  });
});
