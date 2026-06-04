import { Command } from 'commander';
import { program } from './cli-options';

/**
 * These tests exist primarily to exercise the inline option collector
 * callbacks defined in `cli-options.ts` (e.g. `--env`, `--exclude-env`,
 * `--mount`). The callbacks are simple `(value, prev) => [...prev, value]`
 * accumulators, but without a direct test they show as uncovered functions
 * in coverage reports because the production CLI imports `cli-options` at
 * module load and tests that exercise the CLI typically construct a fresh
 * `Command()` rather than reuse the exported `program`.
 */
describe('cli-options program', () => {
  beforeEach(() => {
    // Reset accumulated option values between parses.
    program.setOptionValueWithSource('env', [], 'default');
    program.setOptionValueWithSource('excludeEnv', [], 'default');
    program.setOptionValueWithSource('mount', [], 'default');
  });

  it('exposes the expected metadata', () => {
    expect(program.name()).toBe('awf');
    expect(program.description()).toContain('firewall');
  });

  it('accumulates repeated --env values via the collect callback', () => {
    program.parse(
      ['node', 'awf', '--env', 'FOO=1', '--env', 'BAR=2', '--', 'true'],
      { from: 'node' },
    );
    const opts = program.opts();
    expect(opts.env).toEqual(['FOO=1', 'BAR=2']);
  });

  it('accumulates repeated --exclude-env values', () => {
    program.parse(
      ['node', 'awf', '--exclude-env', 'PATH', '--exclude-env', 'HOME', '--', 'true'],
      { from: 'node' },
    );
    const opts = program.opts();
    expect(opts.excludeEnv).toEqual(['PATH', 'HOME']);
  });

  it('accumulates repeated --mount values', () => {
    program.parse(
      ['node', 'awf', '--mount', '/a:/a:ro', '--mount', '/b:/b', '--', 'true'],
      { from: 'node' },
    );
    const opts = program.opts();
    expect(opts.mount).toEqual(['/a:/a:ro', '/b:/b']);
  });

  it('collector callbacks work when called with no previous value (default parameter)', () => {
    // Access the collector callbacks directly to trigger the default-parameter branch
    // (previous: string[] = []) which is only hit when called without a second argument.
    const envOption = program.options.find((o) => o.long === '--env');
    const excludeEnvOption = program.options.find((o) => o.long === '--exclude-env');
    const mountOption = program.options.find((o) => o.long === '--mount');

    expect(envOption?.parseArg).toBeDefined();
    expect(excludeEnvOption?.parseArg).toBeDefined();
    expect(mountOption?.parseArg).toBeDefined();

    // Call with only one argument to hit the default `previous = []` branch.
    expect(envOption!.parseArg!('KEY=VAL', undefined as unknown as string)).toEqual(['KEY=VAL']);
    expect(excludeEnvOption!.parseArg!('HOME', undefined as unknown as string)).toEqual(['HOME']);
    expect(mountOption!.parseArg!('/a:/b:ro', undefined as unknown as string)).toEqual(['/a:/b:ro']);
  });

  describe('custom formatHelp', () => {
    it('generates help output containing usage and options sections', () => {
      const help = program.helpInformation();
      expect(help).toContain('Usage:');
      expect(help).toContain('Options:');
    });

    it('includes section headers for option groups', () => {
      const help = program.helpInformation();
      expect(help).toContain('Domain Filtering:');
      expect(help).toContain('Image Management:');
      expect(help).toContain('Container Configuration:');
      expect(help).toContain('Network & Security:');
      expect(help).toContain('API Proxy:');
      expect(help).toContain('Logging & Debug:');
    });

    it('includes the arguments section (program has [args...] argument)', () => {
      const help = program.helpInformation();
      expect(help).toContain('Arguments:');
    });

    it('handles a command with no description and no arguments', () => {
      const cmd = new Command('test-sub');
      // No description set, no arguments — exercises the if(desc) false and if(args.length>0) false branches.
      // Borrow the same configureHelp helper by calling formatHelp via helpInformation().
      // We can't call the private formatHelp directly, so use a minimal command that
      // goes through commander's internal pipeline with our configured formatter.
      // The simplest way: copy the configureHelp settings from program onto a sub-command.
      cmd.copyInheritedSettings(program);
      const help = cmd.helpInformation();
      // Should not contain 'Arguments:' or a description paragraph
      expect(help).not.toContain('Arguments:');
    });

    it('falls back to 80-column width when helpWidth is not set on the helper', () => {
      // Exercise the `helpWidth ?? 80` fallback by using a fresh sub-command that
      // inherits the configureHelp formatter but whose helper has no helpWidth.
      const cmd = new Command('narrow-test');
      cmd.copyInheritedSettings(program);
      cmd.option('--foo <val>', 'A test option');
      const help = cmd.helpInformation();
      expect(help).toContain('--foo');
    });
  });
});
