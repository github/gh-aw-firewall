import { spawnSync } from 'child_process';
import * as path from 'path';

describe('agent entrypoint output routing', () => {
  it('keeps complete command stdout parseable as JSON', () => {
    const entrypoint = path.join(__dirname, '..', 'containers', 'agent', 'entrypoint.sh');
    const result = spawnSync(
      '/bin/bash',
      [
        '-c',
        [
          'source "$1"',
          'export AWF_COMMAND_STDOUT_ONLY=1',
          'configure_output_routing',
          'print_banner',
          'run_command_with_stdout printf \'%s\' \'{"models":[]}\'',
        ].join('\n'),
        'entrypoint-output-test',
        entrypoint,
      ],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ models: [] });
    expect(result.stderr).toContain('[entrypoint] Agentic Workflow Firewall');
    expect(result.stdout).not.toContain('[entrypoint]');
  });

  it('preserves normal entrypoint output when stdout-only mode is disabled', () => {
    const entrypoint = path.join(__dirname, '..', 'containers', 'agent', 'entrypoint.sh');
    const result = spawnSync(
      '/bin/bash',
      [
        '-c',
        [
          'source "$1"',
          'configure_output_routing',
          'print_banner',
          'run_command_with_stdout printf \'%s\' \'command-output\'',
        ].join('\n'),
        'entrypoint-output-test',
        entrypoint,
      ],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[entrypoint] Agentic Workflow Firewall');
    expect(result.stdout).toContain('command-output');
  });
});
