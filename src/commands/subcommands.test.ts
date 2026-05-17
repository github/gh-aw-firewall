import { Command } from 'commander';
import { registerSubcommands } from './subcommands';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('../logger', () => require('../test-helpers/mock-logger.test-utils').loggerMockFactory());
jest.mock('./logs', () => ({ logsCommand: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./logs-stats', () => ({ statsCommand: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./logs-summary', () => ({ summaryCommand: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./logs-audit', () => ({ auditCommand: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./predownload', () => ({ predownloadCommand: jest.fn().mockResolvedValue(undefined) }));

import { logger } from '../logger';

const mockedLogger = logger as jest.Mocked<typeof logger>;

/**
 * Creates a fresh Commander program with subcommands registered.
 * exitOverride() prevents process.exit from actually killing the test runner.
 */
function makeProgram(): Command {
  const program = new Command('awf');
  program.exitOverride();
  registerSubcommands(program);
  return program;
}

describe('registerSubcommands', () => {
  let processExitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    processExitSpy.mockRestore();
  });

  describe('command registration', () => {
    it('registers predownload subcommand on the program', () => {
      const program = makeProgram();
      const names = program.commands.map((c) => c.name());
      expect(names).toContain('predownload');
    });

    it('registers logs subcommand on the program', () => {
      const program = makeProgram();
      const names = program.commands.map((c) => c.name());
      expect(names).toContain('logs');
    });

    it('registers logs stats sub-subcommand', () => {
      const program = makeProgram();
      const logsCmd = program.commands.find((c) => c.name() === 'logs')!;
      const subNames = logsCmd.commands.map((c) => c.name());
      expect(subNames).toContain('stats');
    });

    it('registers logs summary sub-subcommand', () => {
      const program = makeProgram();
      const logsCmd = program.commands.find((c) => c.name() === 'logs')!;
      const subNames = logsCmd.commands.map((c) => c.name());
      expect(subNames).toContain('summary');
    });

    it('registers logs audit sub-subcommand', () => {
      const program = makeProgram();
      const logsCmd = program.commands.find((c) => c.name() === 'logs')!;
      const subNames = logsCmd.commands.map((c) => c.name());
      expect(subNames).toContain('audit');
    });
  });

  describe('predownload defaults', () => {
    it('sets default image-registry to ghcr.io/github/gh-aw-firewall', async () => {
      const program = makeProgram();
      const predownload = program.commands.find((c) => c.name() === 'predownload')!;
      await program.parseAsync(['node', 'awf', 'predownload'], { from: 'node' });
      expect(predownload.opts().imageRegistry).toBe('ghcr.io/github/gh-aw-firewall');
    });

    it('sets default image-tag to latest', async () => {
      const program = makeProgram();
      const predownload = program.commands.find((c) => c.name() === 'predownload')!;
      await program.parseAsync(['node', 'awf', 'predownload'], { from: 'node' });
      expect(predownload.opts().imageTag).toBe('latest');
    });

    it('sets default enable-api-proxy to false', async () => {
      const program = makeProgram();
      const predownload = program.commands.find((c) => c.name() === 'predownload')!;
      await program.parseAsync(['node', 'awf', 'predownload'], { from: 'node' });
      expect(predownload.opts().enableApiProxy).toBe(false);
    });

    it('sets default agent-image to default', async () => {
      const program = makeProgram();
      const predownload = program.commands.find((c) => c.name() === 'predownload')!;
      await program.parseAsync(['node', 'awf', 'predownload'], { from: 'node' });
      expect(predownload.opts().agentImage).toBe('default');
    });
  });

  describe('validateFormat (via logs action)', () => {
    it('exits with code 1 for invalid format in logs subcommand', async () => {
      const program = makeProgram();
      await program.parseAsync(['node', 'awf', 'logs', '--format', 'invalid'], { from: 'node' });
      expect(processExitSpy).toHaveBeenCalledWith(1);
      expect(mockedLogger.error).toHaveBeenCalledWith(expect.stringContaining('Invalid format'));
    });

    it('does not exit for valid format "raw" in logs subcommand', async () => {
      const program = makeProgram();
      await program.parseAsync(['node', 'awf', 'logs', '--format', 'raw'], { from: 'node' });
      expect(processExitSpy).not.toHaveBeenCalled();
    });

    it('does not exit for valid format "pretty" in logs subcommand', async () => {
      const program = makeProgram();
      await program.parseAsync(['node', 'awf', 'logs', '--format', 'pretty'], { from: 'node' });
      expect(processExitSpy).not.toHaveBeenCalled();
    });

    it('does not exit for valid format "json" in logs subcommand', async () => {
      const program = makeProgram();
      await program.parseAsync(['node', 'awf', 'logs', '--format', 'json'], { from: 'node' });
      expect(processExitSpy).not.toHaveBeenCalled();
    });

    it('exits with code 1 for invalid format in logs stats subcommand', async () => {
      const program = makeProgram();
      const logsCmd = program.commands.find((c) => c.name() === 'logs')!;
      const statsCmd = logsCmd.commands.find((c) => c.name() === 'stats')!;
      await statsCmd.parseAsync(['node', 'awf', '--format', 'bogus'], { from: 'node' });
      expect(processExitSpy).toHaveBeenCalledWith(1);
      expect(mockedLogger.error).toHaveBeenCalledWith(expect.stringContaining('Invalid format'));
    });

    it('does not exit for valid format in logs stats subcommand', async () => {
      const program = makeProgram();
      await program.parseAsync(['node', 'awf', 'logs', 'stats', '--format', 'json'], { from: 'node' });
      expect(processExitSpy).not.toHaveBeenCalled();
    });

    it('exits with code 1 for invalid format in logs summary subcommand', async () => {
      const program = makeProgram();
      const logsCmd = program.commands.find((c) => c.name() === 'logs')!;
      const summaryCmd = logsCmd.commands.find((c) => c.name() === 'summary')!;
      await summaryCmd.parseAsync(['node', 'awf', '--format', 'bogus'], { from: 'node' });
      expect(processExitSpy).toHaveBeenCalledWith(1);
      expect(mockedLogger.error).toHaveBeenCalledWith(expect.stringContaining('Invalid format'));
    });

    it('does not exit for valid format in logs summary subcommand', async () => {
      const program = makeProgram();
      await program.parseAsync(['node', 'awf', 'logs', 'summary', '--format', 'markdown'], { from: 'node' });
      expect(processExitSpy).not.toHaveBeenCalled();
    });

    it('exits with code 1 for invalid format in logs audit subcommand', async () => {
      const program = makeProgram();
      const logsCmd = program.commands.find((c) => c.name() === 'logs')!;
      const auditCmd = logsCmd.commands.find((c) => c.name() === 'audit')!;
      await auditCmd.parseAsync(['node', 'awf', '--format', 'bogus'], { from: 'node' });
      expect(processExitSpy).toHaveBeenCalledWith(1);
      expect(mockedLogger.error).toHaveBeenCalledWith(expect.stringContaining('Invalid format'));
    });

    it('does not exit for valid format "pretty" in logs audit subcommand', async () => {
      const program = makeProgram();
      await program.parseAsync(['node', 'awf', 'logs', 'audit', '--format', 'pretty'], { from: 'node' });
      expect(processExitSpy).not.toHaveBeenCalled();
    });

    it('exits with code 1 for invalid decision in logs audit subcommand', async () => {
      const program = makeProgram();
      await program.parseAsync(
        ['node', 'awf', 'logs', 'audit', '--format', 'pretty', '--decision', 'badvalue'],
        { from: 'node' }
      );
      expect(processExitSpy).toHaveBeenCalledWith(1);
      expect(mockedLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Invalid decision filter')
      );
    });

    it('does not exit for valid decision "allowed" in logs audit subcommand', async () => {
      const program = makeProgram();
      await program.parseAsync(
        ['node', 'awf', 'logs', 'audit', '--decision', 'allowed'],
        { from: 'node' }
      );
      expect(processExitSpy).not.toHaveBeenCalled();
    });

    it('does not exit for valid decision "denied" in logs audit subcommand', async () => {
      const program = makeProgram();
      await program.parseAsync(
        ['node', 'awf', 'logs', 'audit', '--decision', 'denied'],
        { from: 'node' }
      );
      expect(processExitSpy).not.toHaveBeenCalled();
    });

    it('warns when --with-pid is used without -f in logs subcommand', async () => {
      const program = makeProgram();
      await program.parseAsync(['node', 'awf', 'logs', '--with-pid'], { from: 'node' });
      expect(mockedLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('--with-pid only works with real-time streaming')
      );
    });

    it('does not warn when --with-pid is used with -f', async () => {
      const program = makeProgram();
      await program.parseAsync(['node', 'awf', 'logs', '--with-pid', '-f'], { from: 'node' });
      expect(mockedLogger.warn).not.toHaveBeenCalled();
    });
  });

  describe('predownload action error handling', () => {
    it('exits with predownload error exitCode when predownload throws', async () => {
      const { predownloadCommand } = await import('./predownload');
      const mockedPredownload = predownloadCommand as jest.Mock;
      const err = Object.assign(new Error('pull failed'), { exitCode: 2 });
      mockedPredownload.mockRejectedValueOnce(err);

      const program = makeProgram();
      await program.parseAsync(['node', 'awf', 'predownload'], { from: 'node' });
      expect(processExitSpy).toHaveBeenCalledWith(2);
    });

    it('exits with code 1 when predownload throws without exitCode', async () => {
      const { predownloadCommand } = await import('./predownload');
      const mockedPredownload = predownloadCommand as jest.Mock;
      mockedPredownload.mockRejectedValueOnce(new Error('unknown'));

      const program = makeProgram();
      await program.parseAsync(['node', 'awf', 'predownload'], { from: 'node' });
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });
  });
});
