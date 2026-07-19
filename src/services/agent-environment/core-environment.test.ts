import { buildCoreEnvironment } from './core-environment';
import * as hostIdentity from '../../host-identity';
import { AgentEnvironmentParams } from './types';

describe('buildCoreEnvironment PATH', () => {
  const params = {
    config: {},
    networkConfig: { squidIp: '172.30.0.10' },
    dnsServers: [],
  } as unknown as AgentEnvironmentParams;

  it('prepends the rootless install dir (~/.local/bin) to PATH', () => {
    jest.spyOn(hostIdentity, 'getRealUserHome').mockReturnValue('/home/runner');

    const env = buildCoreEnvironment(params);

    // ~/.local/bin must come first so a rootless-installed copilot binary
    // (install_copilot_cli.sh --rootless) is resolvable by name in the sbx
    // microVM, which runs `bash -lc` with exactly this injected PATH.
    expect(env.PATH).toBe(
      '/home/runner/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    );
    expect(env.PATH.split(':')[0]).toBe('/home/runner/.local/bin');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });
});
