import {
  APPLE_CONTAINER_DEFAULT_ARCH,
  APPLE_CONTAINER_DEFAULT_OS,
  APPLE_CONTAINER_NO_NETWORK,
  buildAppleContainerRunArgs,
  type AppleContainerRunSpec,
} from './run-args';

const MINIMAL: AppleContainerRunSpec = { image: 'ubuntu:22.04' };

/** Returns the value that follows `flag`, or undefined when absent. */
function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

/** Returns every value emitted for a repeatable flag, in order. */
function valuesFor(args: readonly string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag) values.push(args[index + 1]);
  }
  return values;
}

describe('buildAppleContainerRunArgs defaults', () => {
  it('starts with the requested subcommand', () => {
    expect(buildAppleContainerRunArgs(MINIMAL)[0]).toBe('run');
    expect(buildAppleContainerRunArgs(MINIMAL, 'create')[0]).toBe('create');
    expect(buildAppleContainerRunArgs(MINIMAL)).not.toContain('container');
  });

  it('always emits --network none so an unspecified network cannot attach the default NIC', () => {
    const args = buildAppleContainerRunArgs(MINIMAL);
    expect(valueAfter(args, '--network')).toBe(APPLE_CONTAINER_NO_NETWORK);
    expect(valuesFor(args, '--network')).toHaveLength(1);
  });

  it('selects the native arm64 linux platform by default', () => {
    const args = buildAppleContainerRunArgs(MINIMAL);
    expect(valueAfter(args, '--os')).toBe(APPLE_CONTAINER_DEFAULT_OS);
    expect(valueAfter(args, '--arch')).toBe(APPLE_CONTAINER_DEFAULT_ARCH);
    expect(APPLE_CONTAINER_DEFAULT_ARCH).toBe('arm64');
  });

  it('adds no capabilities, no tty, no privileges and no mounts by default', () => {
    const args = buildAppleContainerRunArgs(MINIMAL);
    expect(args).not.toContain('--cap-add');
    expect(args).not.toContain('--tty');
    expect(args).not.toContain('--interactive');
    expect(args).not.toContain('--mount');
    expect(args).not.toContain('--publish-socket');
    expect(args).not.toContain('--rm');
    expect(args).not.toContain('--detach');
    expect(args).not.toContain('--read-only');
  });

  it('places the image last when no container arguments are supplied', () => {
    const args = buildAppleContainerRunArgs(MINIMAL);
    expect(args[args.length - 1]).toBe('ubuntu:22.04');
  });
});

describe('buildAppleContainerRunArgs positional handling', () => {
  it('emits the image before the container arguments', () => {
    const args = buildAppleContainerRunArgs({
      image: 'ubuntu:22.04',
      args: ['bash', '-lc', 'echo hi'],
    });
    expect(args.slice(-4)).toEqual(['ubuntu:22.04', 'bash', '-lc', 'echo hi']);
  });

  it('passes option-like container arguments through verbatim without a -- terminator', () => {
    // `container run` declares its trailing arguments with
    // `.captureForPassthrough`, so leading dashes are safe as-is.
    const args = buildAppleContainerRunArgs({
      image: 'ubuntu:22.04',
      args: ['--rm', '--network', 'default'],
    });
    expect(args).not.toContain('--');
    expect(args.slice(-4)).toEqual(['ubuntu:22.04', '--rm', '--network', 'default']);
    // The real network flag is still the isolated one emitted before the image.
    expect(valueAfter(args, '--network')).toBe(APPLE_CONTAINER_NO_NETWORK);
  });

  it('does not treat an empty argument list as missing', () => {
    expect(buildAppleContainerRunArgs({ image: 'ubuntu:22.04', args: [] })).toEqual(
      buildAppleContainerRunArgs(MINIMAL),
    );
  });
});

describe('buildAppleContainerRunArgs resources and process options', () => {
  it('emits cpu, memory, workdir, user and entrypoint', () => {
    const args = buildAppleContainerRunArgs({
      ...MINIMAL,
      cpus: 4,
      memory: '8G',
      workdir: '/workspace',
      user: '1000:1000',
      entrypoint: '/usr/bin/env',
    });
    expect(valueAfter(args, '--cpus')).toBe('4');
    expect(valueAfter(args, '--memory')).toBe('8G');
    expect(valueAfter(args, '--workdir')).toBe('/workspace');
    expect(valueAfter(args, '--user')).toBe('1000:1000');
    expect(valueAfter(args, '--entrypoint')).toBe('/usr/bin/env');
  });

  it('emits one --env token per variable, preserving values containing "="', () => {
    const args = buildAppleContainerRunArgs({
      ...MINIMAL,
      env: { HTTPS_PROXY: 'http://172.30.0.10:3128', OPTS: 'a=b' },
    });
    expect(valuesFor(args, '--env')).toEqual([
      'HTTPS_PROXY=http://172.30.0.10:3128',
      'OPTS=a=b',
    ]);
  });

  it('emits labels as key=value tokens', () => {
    const args = buildAppleContainerRunArgs({ ...MINIMAL, labels: { awf: 'agent' } });
    expect(valuesFor(args, '--label')).toEqual(['awf=agent']);
  });

  it('rejects an "=" in a label value, which the CLI parses as a third field', () => {
    // Unlike --env, `Parser.labels` splits with maxSplits: 2 and rejects three
    // components, so this must fail here rather than inside `container create`.
    expect(() => buildAppleContainerRunArgs({ ...MINIMAL, labels: { awf: 'a=b' } })).toThrow(
      /label "awf" value must not contain "="/,
    );
  });

  it('rejects a newline in a label value', () => {
    expect(() => buildAppleContainerRunArgs({ ...MINIMAL, labels: { awf: 'a\nb' } })).toThrow(
      /NUL or newlines/,
    );
  });

  it.each([
    ['cpus', { cpus: 0 }],
    ['memory', { memory: '8GB' }],
    ['workdir', { workdir: 'workspace' }],
    ['user', { user: 'root; rm -rf /' }],
    ['name', { name: '-bad' }],
  ])('rejects an invalid %s', (_label, overrides) => {
    expect(() => buildAppleContainerRunArgs({ ...MINIMAL, ...overrides })).toThrow();
  });

  it('rejects an environment value containing a newline', () => {
    expect(() =>
      buildAppleContainerRunArgs({ ...MINIMAL, env: { TOKEN: 'a\nb' } }),
    ).toThrow(/NUL or newlines/);
  });
});

describe('buildAppleContainerRunArgs isolation controls', () => {
  it('emits --read-only and bounded read-only paths', () => {
    const args = buildAppleContainerRunArgs({
      ...MINIMAL,
      readOnlyRootfs: true,
      readOnlyPaths: ['/etc', '/usr'],
    });
    expect(args).toContain('--read-only');
    expect(valuesFor(args, '--read-only-path')).toEqual(['/etc', '/usr']);
  });

  it('emits each dropped and added capability separately', () => {
    const args = buildAppleContainerRunArgs({
      ...MINIMAL,
      capDrop: ['ALL'],
      capAdd: ['CAP_CHOWN'],
    });
    expect(valuesFor(args, '--cap-drop')).toEqual(['ALL']);
    expect(valuesFor(args, '--cap-add')).toEqual(['CAP_CHOWN']);
  });

  it('rejects an invalid capability name', () => {
    expect(() => buildAppleContainerRunArgs({ ...MINIMAL, capDrop: ['ALL;ls'] })).toThrow(
      /capability name is not valid/,
    );
  });
});

describe('buildAppleContainerRunArgs mounts', () => {
  it('builds a read-write bind mount token', () => {
    const args = buildAppleContainerRunArgs({
      ...MINIMAL,
      mounts: [{ source: '/host/workspace', target: '/workspace' }],
    });
    expect(valuesFor(args, '--mount')).toEqual([
      'type=bind,source=/host/workspace,target=/workspace',
    ]);
  });

  it('appends readonly to the token when requested', () => {
    const args = buildAppleContainerRunArgs({
      ...MINIMAL,
      mounts: [{ source: '/host/tools', target: '/tools', readOnly: true }],
    });
    expect(valuesFor(args, '--mount')).toEqual([
      'type=bind,source=/host/tools,target=/tools,readonly',
    ]);
  });

  it('preserves mount order', () => {
    const args = buildAppleContainerRunArgs({
      ...MINIMAL,
      mounts: [
        { source: '/a', target: '/a' },
        { source: '/b', target: '/b', readOnly: true },
      ],
    });
    expect(valuesFor(args, '--mount')).toEqual([
      'type=bind,source=/a,target=/a',
      'type=bind,source=/b,target=/b,readonly',
    ]);
  });

  it.each([
    ['a comma in the source, which would inject a sibling mount field', '/host,readonly', '/t'],
    ['an equals sign in the target, which would inject a key', '/host', '/t=x'],
  ])('rejects %s', (_label, source, target) => {
    expect(() => buildAppleContainerRunArgs({ ...MINIMAL, mounts: [{ source, target }] })).toThrow(
      /delimits fields/,
    );
  });

  it('builds a publish-socket token for a Unix socket mount', () => {
    const args = buildAppleContainerRunArgs({
      ...MINIMAL,
      socketMounts: [{ hostPath: '/run/awf/agent.sock', containerPath: '/run/awf.sock' }],
    });
    expect(valuesFor(args, '--publish-socket')).toEqual([
      '/run/awf/agent.sock:/run/awf.sock',
    ]);
  });

  it('rejects a colon in a socket path, which would inject a second field', () => {
    expect(() =>
      buildAppleContainerRunArgs({
        ...MINIMAL,
        socketMounts: [{ hostPath: '/run/a:/b', containerPath: '/run/awf.sock' }],
      }),
    ).toThrow(/must not contain ":"/);
  });
});

describe('buildAppleContainerRunArgs network policy', () => {
  it('emits one --network flag per attached network', () => {
    const args = buildAppleContainerRunArgs({
      ...MINIMAL,
      network: { kind: 'attach', networks: ['awf-net', 'awf-enclave'] },
    });
    expect(valuesFor(args, '--network')).toEqual(['awf-net', 'awf-enclave']);
  });

  it('rejects an empty attach list rather than silently falling back', () => {
    expect(() =>
      buildAppleContainerRunArgs({ ...MINIMAL, network: { kind: 'attach', networks: [] } }),
    ).toThrow(/requires at least one network name/);
  });

  it('rejects mixing the "none" sentinel with real networks', () => {
    expect(() =>
      buildAppleContainerRunArgs({
        ...MINIMAL,
        network: { kind: 'attach', networks: ['awf-net', 'none'] },
      }),
    ).toThrow(/cannot be combined with other networks/);
  });

  it('rejects an invalid network name', () => {
    expect(() =>
      buildAppleContainerRunArgs({
        ...MINIMAL,
        network: { kind: 'attach', networks: ['net,mac=00:11:22:33:44:55'] },
      }),
    ).toThrow(/network name is not valid/);
  });
});

describe('buildAppleContainerRunArgs boot and execution options', () => {
  it('emits the custom init image and init flag', () => {
    const args = buildAppleContainerRunArgs({
      ...MINIMAL,
      initImage: 'ghcr.io/github/gh-aw-firewall/init:latest',
      useInit: true,
    });
    expect(valueAfter(args, '--init-image')).toBe('ghcr.io/github/gh-aw-firewall/init:latest');
    expect(args).toContain('--init');
  });

  it('rejects an option-like init image', () => {
    expect(() => buildAppleContainerRunArgs({ ...MINIMAL, initImage: '--evil' })).toThrow(
      /must not begin with "-"/,
    );
  });

  it('emits interactive without tty for non-TTY CI execution', () => {
    const args = buildAppleContainerRunArgs({ ...MINIMAL, interactive: true });
    expect(args).toContain('--interactive');
    expect(args).not.toContain('--tty');
  });

  it('emits tty only when explicitly requested', () => {
    expect(buildAppleContainerRunArgs({ ...MINIMAL, tty: true })).toContain('--tty');
  });

  it('emits detach, rm, cidfile and name', () => {
    const args = buildAppleContainerRunArgs({
      ...MINIMAL,
      name: 'awf-agent',
      detach: true,
      removeOnExit: true,
      cidFile: '/tmp/awf/cid',
    });
    expect(valueAfter(args, '--name')).toBe('awf-agent');
    expect(args).toContain('--detach');
    expect(args).toContain('--rm');
    expect(valueAfter(args, '--cidfile')).toBe('/tmp/awf/cid');
  });
});

describe('buildAppleContainerRunArgs determinism', () => {
  it('produces identical argv for identical specs', () => {
    const spec: AppleContainerRunSpec = {
      image: 'ubuntu:22.04',
      name: 'awf-agent',
      cpus: 2,
      memory: '4G',
      env: { A: '1', B: '2' },
      mounts: [{ source: '/a', target: '/a' }],
      args: ['bash'],
    };
    expect(buildAppleContainerRunArgs(spec)).toEqual(buildAppleContainerRunArgs(spec));
  });

  it('differs from the create form only in the leading subcommand', () => {
    const run = buildAppleContainerRunArgs(MINIMAL, 'run');
    const create = buildAppleContainerRunArgs(MINIMAL, 'create');
    expect(run.slice(1)).toEqual(create.slice(1));
  });
});
