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
});
