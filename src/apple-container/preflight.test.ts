import {
  APPLE_CONTAINER_MINIMUM_CLI_VERSION,
  AppleContainerPreflightError,
  compareAppleContainerVersions,
  runAppleContainerPreflight,
  type AppleContainerPreflightDependencies,
} from './preflight';
import { AppleContainerCli } from './cli';
import type { AppleContainerHostProbe } from './host-facts';
import type { AppleContainerLifecycle } from './lifecycle';

function darwinProbe(
  overrides: Partial<AppleContainerHostProbe> = {},
): Partial<AppleContainerHostProbe> {
  return {
    platform: 'darwin',
    arch: 'arm64',
    readProductVersion: async () => '26.1',
    readHypervisorSupport: async () => '1',
    ...overrides,
  };
}

type StubLifecycle = AppleContainerPreflightDependencies['lifecycle'];

function stubLifecycle(overrides: {
  version?: () => Promise<{ version: string; raw: string }>;
  systemStatus?: () => Promise<{ healthy: boolean; result: { stdout: string; stderr: string } }>;
  binary?: string;
} = {}): StubLifecycle {
  return {
    cli: { binary: overrides.binary ?? 'container' },
    version: overrides.version ?? (async () => ({ version: '0.4.1', raw: 'container CLI version 0.4.1' })),
    systemStatus:
      overrides.systemStatus
      ?? (async () => ({ healthy: true, result: { stdout: '{}', stderr: '' } })),
  } as unknown as AppleContainerLifecycle;
}

describe('compareAppleContainerVersions', () => {
  it.each([
    ['0.4.1', '0.4.0', 1],
    ['0.4.0', '0.4.1', -1],
    ['0.4.0', '0.4.0', 0],
    ['0.4', '0.4.0', 0],
    ['1.0.0', '0.9.9', 1],
    ['0.10.0', '0.9.0', 1],
    ['v0.5.0', '0.4.0', 1],
  ])('compares %s to %s', (left, right, expected) => {
    expect(Math.sign(compareAppleContainerVersions(left, right))).toBe(expected);
  });

  it('throws on a non-numeric component rather than guessing', () => {
    expect(() => compareAppleContainerVersions('0.4.x', '0.4.0')).toThrow(/not a number/);
  });
});

describe('runAppleContainerPreflight host gates', () => {
  it('fails on a non-Darwin platform before touching the CLI', async () => {
    const version = jest.fn();
    const promise = runAppleContainerPreflight({
      hostProbe: { platform: 'linux', arch: 'x64' },
      lifecycle: stubLifecycle({ version: version as never }),
    });

    await expect(promise).rejects.toBeInstanceOf(AppleContainerPreflightError);
    await expect(promise).rejects.toMatchObject({ code: 'platform' });
    expect(version).not.toHaveBeenCalled();
  });

  it('fails on Intel macOS with an architecture code', async () => {
    await expect(
      runAppleContainerPreflight({
        hostProbe: darwinProbe({ arch: 'x64' }),
        lifecycle: stubLifecycle(),
      }),
    ).rejects.toMatchObject({ code: 'architecture' });
  });

  it('fails on macOS older than 26', async () => {
    await expect(
      runAppleContainerPreflight({
        hostProbe: darwinProbe({ readProductVersion: async () => '15.5' }),
        lifecycle: stubLifecycle(),
      }),
    ).rejects.toMatchObject({ code: 'macos-version' });
  });

  it('fails with a hypervisor code on a GitHub-hosted macOS runner', async () => {
    const promise = runAppleContainerPreflight({
      hostProbe: darwinProbe({ readHypervisorSupport: async () => '0' }),
      lifecycle: stubLifecycle(),
    });

    await expect(promise).rejects.toMatchObject({ code: 'hypervisor' });
    await expect(promise).rejects.toThrow(/nested virtualization/);
  });

  it('translates a probe failure into a preflight error with the probe cause code', async () => {
    await expect(
      runAppleContainerPreflight({
        hostProbe: darwinProbe({
          readProductVersion: async () => {
            throw new Error('spawn ENOENT');
          },
        }),
        lifecycle: stubLifecycle(),
      }),
    ).rejects.toMatchObject({ code: 'macos-version' });
  });
});

describe('runAppleContainerPreflight CLI gates', () => {
  it('reports a missing CLI with an actionable message', async () => {
    const promise = runAppleContainerPreflight({
      hostProbe: darwinProbe(),
      lifecycle: stubLifecycle({
        version: async () => {
          throw new Error('spawn container ENOENT');
        },
      }),
    });

    await expect(promise).rejects.toMatchObject({ code: 'cli-missing' });
    await expect(promise).rejects.toThrow(
      /(?:^|\s)https?:\/\/github\.com\/apple\/container(?:\/|\s|$)/,
    );
  });

  it('rejects a CLI older than the pinned minimum', async () => {
    const promise = runAppleContainerPreflight({
      hostProbe: darwinProbe(),
      lifecycle: stubLifecycle({
        version: async () => ({ version: '0.3.9', raw: 'container CLI version 0.3.9' }),
      }),
    });

    await expect(promise).rejects.toMatchObject({ code: 'cli-version' });
    await expect(promise).rejects.toThrow(
      new RegExp(`${APPLE_CONTAINER_MINIMUM_CLI_VERSION.replace(/\./g, '\\.')} or newer`),
    );
  });

  it('accepts a CLI newer than the minimum', async () => {
    await expect(
      runAppleContainerPreflight({
        hostProbe: darwinProbe(),
        lifecycle: stubLifecycle({
          version: async () => ({ version: '1.2.0', raw: 'container CLI version 1.2.0' }),
        }),
      }),
    ).resolves.toMatchObject({ cliVersion: '1.2.0' });
  });

  it('honours a caller-supplied minimum version', async () => {
    await expect(
      runAppleContainerPreflight({
        hostProbe: darwinProbe(),
        minimumCliVersion: '9.9.9',
        lifecycle: stubLifecycle(),
      }),
    ).rejects.toMatchObject({ code: 'cli-version' });
  });

  it('reports an unparseable banner from the real lifecycle as a version failure', async () => {
    // Exercised at the spawn level rather than by stubbing the lifecycle: the
    // real version() throws on an unparseable banner, so a lifecycle-level stub
    // that resolves with a bad version could not reach this branch.
    const promise = runAppleContainerPreflight({
      hostProbe: darwinProbe(),
      cli: new AppleContainerCli({
        spawn: async () => ({
          exitCode: 0,
          signal: null,
          stdout: 'container CLI (build: release)',
          stderr: '',
          timedOut: false,
        }),
      }),
    });

    await expect(promise).rejects.toMatchObject({ code: 'cli-version' });
    await expect(promise).rejects.toThrow(/Could not parse Apple Container CLI version/);
    await expect(promise).rejects.not.toThrow(/ensure it is on PATH/);
  });

  it('still reports a CLI that cannot be spawned as cli-missing', async () => {
    const promise = runAppleContainerPreflight({
      hostProbe: darwinProbe(),
      cli: new AppleContainerCli({
        spawn: async () => {
          throw new Error('spawn container ENOENT');
        },
      }),
    });

    await expect(promise).rejects.toMatchObject({ code: 'cli-missing' });
    await expect(promise).rejects.toThrow(/ensure it is on PATH/);
  });

  it('reports a non-zero --version exit as cli-missing', async () => {
    await expect(
      runAppleContainerPreflight({
        hostProbe: darwinProbe(),
        cli: new AppleContainerCli({
          spawn: async () => ({
            exitCode: 127,
            signal: null,
            stdout: '',
            stderr: 'command not found',
            timedOut: false,
          }),
        }),
      }),
    ).rejects.toMatchObject({ code: 'cli-missing' });
  });
});

describe('runAppleContainerPreflight service gate', () => {
  it('fails when the service is not healthy and suggests how to start it', async () => {
    const promise = runAppleContainerPreflight({
      hostProbe: darwinProbe(),
      lifecycle: stubLifecycle({
        systemStatus: async () => ({
          healthy: false,
          result: { stdout: 'apiserver is not running', stderr: '' },
        }),
      }),
    });

    await expect(promise).rejects.toMatchObject({ code: 'service-health' });
    await expect(promise).rejects.toThrow(/container system start/);
    await expect(promise).rejects.toThrow(/apiserver is not running/);
  });

  it('still produces a message when the failing status printed nothing', async () => {
    await expect(
      runAppleContainerPreflight({
        hostProbe: darwinProbe(),
        lifecycle: stubLifecycle({
          systemStatus: async () => ({ healthy: false, result: { stdout: '', stderr: '' } }),
        }),
      }),
    ).rejects.toThrow(/container system start"\./);
  });
});

describe('runAppleContainerPreflight success', () => {
  it('returns the validated host contract', async () => {
    const result = await runAppleContainerPreflight({
      hostProbe: darwinProbe({ readProductVersion: async () => '26.2.1' }),
      lifecycle: stubLifecycle({ binary: '/usr/local/bin/container' }),
    });

    expect(result).toEqual({
      facts: {
        platform: 'darwin',
        arch: 'arm64',
        macosProductVersion: '26.2.1',
        hypervisorSupported: true,
      },
      cliBinary: '/usr/local/bin/container',
      cliVersion: '0.4.1',
    });
  });

  it('builds a lifecycle from supplied CLI options when none is injected', async () => {
    const promise = runAppleContainerPreflight({
      hostProbe: darwinProbe(),
      cli: new AppleContainerCli({
        binary: '/opt/container',
        spawn: async (_binary, args) => ({
          exitCode: 0,
          signal: null,
          stdout: args[0] === '--version' ? 'container CLI version 0.4.5' : '{"status":"running"}',
          stderr: '',
          timedOut: false,
        }),
      }),
    });

    await expect(promise).resolves.toMatchObject({
      cliBinary: '/opt/container',
      cliVersion: '0.4.5',
    });
  });
});
