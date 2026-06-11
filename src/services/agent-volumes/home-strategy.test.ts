import { buildHomeMounts } from './home-strategy';
import { logger } from '../../logger';

// Mock fs so that accessSync and existsSync can be controlled per test.
jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...actual,
    accessSync: jest.fn((...args: Parameters<typeof actual.accessSync>) =>
      actual.accessSync(...args)
    ),
    existsSync: jest.fn((...args: Parameters<typeof actual.existsSync>) =>
      actual.existsSync(...args)
    ),
  };
});

import * as fs from 'fs';

jest.mock('../../runner-tool-cache', () => ({
  resolveRunnerToolCachePath: jest.fn().mockReturnValue(undefined),
}));

function makeParams(effectiveHome = '/home/runner'): Parameters<typeof buildHomeMounts>[0] {
  return {
    config: {
      workDir: '/tmp/awf-test',
      agentCommand: 'echo test',
      allowedDomains: [],
    } as unknown as Parameters<typeof buildHomeMounts>[0]['config'],
    effectiveHome,
    agentLogsPath: '/tmp/awf-test/agent-logs',
    sessionStatePath: '/tmp/awf-test/agent-session-state',
  };
}

/** Make fs.existsSync return true only for paths ending with `.copilot`. */
function mockExistsForCopilot(): void {
  (fs.existsSync as jest.Mock).mockImplementation((p: unknown) => {
    if (typeof p === 'string' && p.endsWith('.copilot')) return true;
    return false;
  });
}

describe('buildHomeMounts', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('~/.copilot access error handling', () => {
    it('includes error.message in warning when accessSync throws an Error instance', () => {
      mockExistsForCopilot();
      (fs.accessSync as jest.Mock).mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });

      const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
      buildHomeMounts(makeParams());

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('EACCES: permission denied')
      );
    });

    it('includes String(error) in warning when accessSync throws a non-Error value', () => {
      mockExistsForCopilot();
      (fs.accessSync as jest.Mock).mockImplementation(() => {
        throw 'non-error permission failure'; // NOLINT: intentionally throwing a non-Error to test the String(error) branch
      });

      const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
      buildHomeMounts(makeParams());

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('non-error permission failure')
      );
    });

    it('skips the .copilot bind mount when accessSync throws', () => {
      mockExistsForCopilot();
      (fs.accessSync as jest.Mock).mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });

      jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const mounts = buildHomeMounts(makeParams());

      expect(mounts).not.toContain(
        '/home/runner/.copilot:/host/home/runner/.copilot:rw'
      );
    });
  });
});
