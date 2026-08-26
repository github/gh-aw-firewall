import {
  AppleContainerCli,
  AppleContainerCliError,
  type AppleContainerSpawn,
  type AppleContainerSpawnOptions,
  type AppleContainerSpawnResult,
} from './cli';
import {
  AppleContainerLifecycle,
  parseAppleContainerJson,
  parseAppleContainerVersion,
  parseCreatedContainerId,
} from './lifecycle';

interface RecordedCall {
  args: readonly string[];
  options: AppleContainerSpawnOptions;
}

interface Harness {
  lifecycle: AppleContainerLifecycle;
  calls: RecordedCall[];
}

function harness(
  respond: (args: readonly string[]) => Partial<AppleContainerSpawnResult> = () => ({}),
): Harness {
  const calls: RecordedCall[] = [];
  const spawn: AppleContainerSpawn = async (_binary, args, options) => {
    calls.push({ args, options });
    return {
      exitCode: 0,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      ...respond(args),
    };
  };
  return { lifecycle: new AppleContainerLifecycle(new AppleContainerCli({ spawn })), calls };
}

describe('parseAppleContainerVersion', () => {
  it('parses the documented banner form', () => {
    expect(
      parseAppleContainerVersion('container CLI version 0.4.1 (build: release, commit: abcdef1)'),
    ).toEqual({
      version: '0.4.1',
      raw: 'container CLI version 0.4.1 (build: release, commit: abcdef1)',
    });
  });

  it('parses a two-component version', () => {
    expect(parseAppleContainerVersion('container CLI version 1.0').version).toBe('1.0');
  });

  it('parses a bare semantic version', () => {
    expect(parseAppleContainerVersion('v0.5.2').version).toBe('0.5.2');
  });

  it.each(['', 'container CLI', 'unknown build'])('throws on %j', (value) => {
    expect(() => parseAppleContainerVersion(value)).toThrow(/Could not parse/);
  });

  it.each(['container CLI (build: 99.0)', 'release 99.0'])('rejects an unanchored version in %j', (value) => {
    expect(() => parseAppleContainerVersion(value)).toThrow(/Could not parse/);
  });
});

describe('parseCreatedContainerId', () => {
  it('returns the printed ID', () => {
    expect(parseCreatedContainerId('awf-agent\n')).toBe('awf-agent');
  });

  it('uses the last non-empty line so leading progress output cannot corrupt the ID', () => {
    expect(parseCreatedContainerId('pulling...\n\nawf-agent\n\n')).toBe('awf-agent');
  });

  it('throws when nothing was printed', () => {
    expect(() => parseCreatedContainerId('  \n\n')).toThrow(/did not print a container ID/);
  });

  it('validates the returned ID rather than trusting it', () => {
    expect(() => parseCreatedContainerId('not a valid id')).toThrow(/created container ID/);
  });
});

describe('parseAppleContainerJson', () => {
  it('parses valid JSON', () => {
    expect(parseAppleContainerJson('list', ' [{"id":"a"}] ')).toEqual([{ id: 'a' }]);
  });

  it('throws rather than defaulting on empty output', () => {
    expect(() => parseAppleContainerJson('list', '   ')).toThrow(/returned no JSON output/);
  });

  it('throws on malformed JSON', () => {
    expect(() => parseAppleContainerJson('inspect', '{oops')).toThrow(/unparseable JSON/);
  });
});

describe('AppleContainerLifecycle.version', () => {
  it('runs "container --version" and parses stdout', async () => {
    const { lifecycle, calls } = harness(() => ({
      stdout: 'container CLI version 0.4.1 (build: release, commit: abc1234)',
    }));

    await expect(lifecycle.version()).resolves.toMatchObject({ version: '0.4.1' });
    expect(calls[0].args).toEqual(['--version']);
  });

  it('falls back to stderr when the banner is printed there', async () => {
    const { lifecycle } = harness(() => ({ stderr: 'container CLI version 0.4.2' }));
    await expect(lifecycle.version()).resolves.toMatchObject({ version: '0.4.2' });
  });

  it('throws when the CLI exits non-zero', async () => {
    const { lifecycle } = harness(() => ({ exitCode: 127, stderr: 'command not found' }));
    await expect(lifecycle.version()).rejects.toBeInstanceOf(AppleContainerCliError);
  });
});

describe('AppleContainerLifecycle.systemStatus', () => {
  it('requests JSON and reports healthy on exit 0', async () => {
    const { lifecycle, calls } = harness(() => ({ stdout: '{"status":"running"}' }));

    await expect(lifecycle.systemStatus()).resolves.toMatchObject({ healthy: true });
    expect(calls[0].args).toEqual(['system', 'status', '--format', 'json']);
  });

  it('reports unhealthy instead of throwing when the service is down', async () => {
    const { lifecycle } = harness(() => ({
      exitCode: 1,
      stdout: 'apiserver is not running',
    }));

    const status = await lifecycle.systemStatus();
    expect(status.healthy).toBe(false);
    expect(status.result.stdout).toContain('apiserver is not running');
  });
});

describe('AppleContainerLifecycle.pullImage', () => {
  it('pulls with no platform flags by default', async () => {
    const { lifecycle, calls } = harness();
    await lifecycle.pullImage('ubuntu:22.04');
    expect(calls[0].args).toEqual(['image', 'pull', 'ubuntu:22.04']);
  });

  it('uses the singular "image" subcommand group', async () => {
    const { lifecycle, calls } = harness();
    await lifecycle.pullImage('ubuntu:22.04');
    expect(calls[0].args[0]).toBe('image');
  });

  it('emits --os and --arch for native arm64 selection', async () => {
    const { lifecycle, calls } = harness();
    await lifecycle.pullImage('ubuntu:22.04', { os: 'linux', arch: 'arm64' });
    expect(calls[0].args).toEqual([
      'image', 'pull', '--os', 'linux', '--arch', 'arm64', 'ubuntu:22.04',
    ]);
  });

  it('prefers --platform and omits --os/--arch when it is supplied', async () => {
    const { lifecycle, calls } = harness();
    await lifecycle.pullImage('ubuntu:22.04', {
      platform: 'linux/arm64',
      os: 'linux',
      arch: 'amd64',
    });
    expect(calls[0].args).toEqual(['image', 'pull', '--platform', 'linux/arm64', 'ubuntu:22.04']);
  });

  it.each(['linux', 'linux/arm64/v8/extra', 'Linux/arm64', 'linux/'])(
    'rejects the malformed platform %j',
    async (platform) => {
      const { lifecycle } = harness();
      await expect(lifecycle.pullImage('ubuntu:22.04', { platform })).rejects.toThrow(
        /"os\/arch\[\/variant\]"/,
      );
    },
  );

  it('rejects a malformed architecture component', async () => {
    const { lifecycle } = harness();
    await expect(lifecycle.pullImage('ubuntu:22.04', { arch: 'arm64 x' })).rejects.toThrow(
      /lowercase alphanumeric/,
    );
  });

  it('throws when the pull fails', async () => {
    const { lifecycle } = harness(() => ({ exitCode: 1, stderr: 'manifest unknown' }));
    await expect(lifecycle.pullImage('ubuntu:nope')).rejects.toThrow(/manifest unknown/);
  });
});

describe('AppleContainerLifecycle.create', () => {
  it('runs the create subcommand and returns the validated ID', async () => {
    const { lifecycle, calls } = harness(() => ({ stdout: 'awf-agent\n' }));

    await expect(lifecycle.create({ image: 'ubuntu:22.04', name: 'awf-agent' })).resolves.toBe(
      'awf-agent',
    );
    expect(calls[0].args[0]).toBe('create');
    expect(calls[0].args).toContain('--network');
  });

  it('throws when create fails rather than returning a placeholder ID', async () => {
    const { lifecycle } = harness(() => ({ exitCode: 1, stderr: 'image not found' }));
    await expect(lifecycle.create({ image: 'ubuntu:22.04' })).rejects.toThrow(/image not found/);
  });
});

describe('AppleContainerLifecycle start and foreground execution', () => {
  it('starts a container without attaching', async () => {
    const { lifecycle, calls } = harness();
    await lifecycle.start('awf-agent');
    expect(calls[0].args).toEqual(['start', 'awf-agent']);
  });

  it('attaches stdio without stdin by default and propagates a non-zero exit code', async () => {
    const { lifecycle, calls } = harness(() => ({ exitCode: 7 }));

    const result = await lifecycle.startAttached('awf-agent');

    expect(calls[0].args).toEqual(['start', '--attach', 'awf-agent']);
    expect(calls[0].options.inheritStdio).toBe(true);
    expect(result.exitCode).toBe(7);
  });

  it('adds --interactive only when stdin is explicitly requested', async () => {
    const { lifecycle, calls } = harness();
    await lifecycle.startAttached('awf-agent', { interactive: true });
    expect(calls[0].args).toEqual(['start', '--attach', '--interactive', 'awf-agent']);
  });

  it('does not forward the interactive flag into the spawn options', async () => {
    const { lifecycle, calls } = harness();
    await lifecycle.startAttached('awf-agent', { interactive: true, timeoutMs: 5 });
    expect(calls[0].options).not.toHaveProperty('interactive');
    expect(calls[0].options.timeoutMs).toBe(5);
  });

  it('runs in the foreground with inherited stdio and returns the exit code verbatim', async () => {
    const { lifecycle, calls } = harness(() => ({ exitCode: 137 }));

    const result = await lifecycle.runForeground({
      image: 'ubuntu:22.04',
      args: ['bash', '-lc', 'exit 137'],
    });

    expect(calls[0].args[0]).toBe('run');
    expect(calls[0].args.slice(-4)).toEqual(['ubuntu:22.04', 'bash', '-lc', 'exit 137']);
    expect(calls[0].options.inheritStdio).toBe(true);
    expect(result.exitCode).toBe(137);
  });

  it('surfaces a foreground timeout without converting it into success', async () => {
    const { lifecycle } = harness(() => ({ exitCode: null, signal: 'SIGTERM', timedOut: true }));

    const result = await lifecycle.runForeground({ image: 'ubuntu:22.04' }, { timeoutMs: 10 });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it('lets a caller override the inherited stdio for a captured run', async () => {
    const { lifecycle, calls } = harness();
    await lifecycle.runForeground({ image: 'ubuntu:22.04' }, { inheritStdio: false });
    expect(calls[0].options.inheritStdio).toBe(false);
  });

  it('rejects an invalid container ID before spawning anything', async () => {
    const { lifecycle, calls } = harness();
    await expect(lifecycle.start('-evil')).rejects.toThrow(/container ID/);
    expect(calls).toHaveLength(0);
  });
});

describe('AppleContainerLifecycle teardown', () => {
  it('stops with no extra flags by default', async () => {
    const { lifecycle, calls } = harness();
    await lifecycle.stop('awf-agent');
    expect(calls[0].args).toEqual(['stop', 'awf-agent']);
  });

  it('stops with an explicit signal and grace period', async () => {
    const { lifecycle, calls } = harness();
    await lifecycle.stop('awf-agent', { signal: 'TERM', timeoutSeconds: 30 });
    expect(calls[0].args).toEqual([
      'stop', '--signal', 'TERM', '--time', '30', 'awf-agent',
    ]);
  });

  it('allows a zero-second stop grace period', async () => {
    const { lifecycle, calls } = harness();
    await lifecycle.stop('awf-agent', { timeoutSeconds: 0 });
    expect(calls[0].args).toEqual(['stop', '--time', '0', 'awf-agent']);
  });

  it('rejects an invalid stop signal before spawning', async () => {
    const { lifecycle, calls } = harness();
    await expect(lifecycle.stop('awf-agent', { signal: 'TERM;ls' })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('kills with SIGKILL by default', async () => {
    const { lifecycle, calls } = harness();
    await lifecycle.kill('awf-agent');
    expect(calls[0].args).toEqual(['kill', '--signal', 'KILL', 'awf-agent']);
  });

  it('kills with an explicit signal', async () => {
    const { lifecycle, calls } = harness();
    await lifecycle.kill('awf-agent', 'SIGUSR1');
    expect(calls[0].args).toEqual(['kill', '--signal', 'SIGUSR1', 'awf-agent']);
  });

  it('deletes without force by default', async () => {
    const { lifecycle, calls } = harness();
    await lifecycle.remove('awf-agent');
    expect(calls[0].args).toEqual(['delete', 'awf-agent']);
  });

  it('deletes with force when requested', async () => {
    const { lifecycle, calls } = harness();
    await lifecycle.remove('awf-agent', { force: true });
    expect(calls[0].args).toEqual(['delete', '--force', 'awf-agent']);
  });

  it('propagates a delete failure', async () => {
    const { lifecycle } = harness(() => ({ exitCode: 1, stderr: 'container is running' }));
    await expect(lifecycle.remove('awf-agent')).rejects.toThrow(/container is running/);
  });
});

describe('AppleContainerLifecycle introspection', () => {
  it('inspects without a --format flag, which the command does not accept', async () => {
    const { lifecycle, calls } = harness(() => ({ stdout: '[{"id":"awf-agent"}]' }));

    await expect(lifecycle.inspect('awf-agent')).resolves.toEqual([{ id: 'awf-agent' }]);
    expect(calls[0].args).toEqual(['inspect', 'awf-agent']);
    expect(calls[0].args).not.toContain('--format');
  });

  it('lists running containers as JSON', async () => {
    const { lifecycle, calls } = harness(() => ({ stdout: '[]' }));

    await expect(lifecycle.list()).resolves.toEqual([]);
    expect(calls[0].args).toEqual(['list', '--format', 'json']);
  });

  it('lists all containers when requested', async () => {
    const { lifecycle, calls } = harness(() => ({ stdout: '[]' }));
    await lifecycle.list({ all: true });
    expect(calls[0].args).toEqual(['list', '--all', '--format', 'json']);
  });

  it('throws on unparseable inspect output rather than returning null', async () => {
    const { lifecycle } = harness(() => ({ stdout: 'not json' }));
    await expect(lifecycle.inspect('awf-agent')).rejects.toThrow(/unparseable JSON/);
  });
});

describe('AppleContainerLifecycle construction', () => {
  it('accepts CLI options directly', () => {
    const lifecycle = new AppleContainerLifecycle({ binary: '/opt/bin/container' });
    expect(lifecycle.cli.binary).toBe('/opt/bin/container');
  });

  it('reuses an existing CLI instance', () => {
    const cli = new AppleContainerCli({ binary: '/opt/bin/container' });
    expect(new AppleContainerLifecycle(cli).cli).toBe(cli);
  });
});
