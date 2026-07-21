import { WrapperConfig } from '../types';
import { baseConfig, mockNetworkConfig } from '../test-helpers/docker-test-fixtures.test-utils';
import { testHelpers } from './optional-services';

describe('optional-services helpers', () => {
  describe('presetSidecarIpEnvVars', () => {
    it('sets sidecar IP env vars and network-isolation marker when enabled', () => {
      const environment: Record<string, string> = {};
      const config: WrapperConfig = {
        ...baseConfig,
        workDir: '/tmp/awf-work',
        enableApiProxy: true,
        difcProxyHost: 'host.docker.internal:18443',
        networkIsolation: true,
      };

      testHelpers.presetSidecarIpEnvVars(environment, config, {
        ...mockNetworkConfig,
        proxyIp: '172.30.0.30',
        cliProxyIp: '172.30.0.50',
      });

      expect(environment).toMatchObject({
        AWF_API_PROXY_IP: '172.30.0.30',
        AWF_CLI_PROXY_IP: '172.30.0.50',
        AWF_NETWORK_ISOLATION: '1',
      });
    });

    it('does not set sidecar IP env vars when features are disabled', () => {
      const environment: Record<string, string> = {};
      const config: WrapperConfig = {
        ...baseConfig,
        workDir: '/tmp/awf-work',
      };

      testHelpers.presetSidecarIpEnvVars(environment, config, mockNetworkConfig);

      expect(environment.AWF_API_PROXY_IP).toBeUndefined();
      expect(environment.AWF_CLI_PROXY_IP).toBeUndefined();
      expect(environment.AWF_NETWORK_ISOLATION).toBeUndefined();
      expect(environment.AWF_SKIP_IPTABLES_INIT).toBeUndefined();
    });

    it('sets AWF_SKIP_IPTABLES_INIT for gVisor without network isolation', () => {
      const environment: Record<string, string> = {};
      const config: WrapperConfig = {
        ...baseConfig,
        workDir: '/tmp/awf-work',
        containerRuntime: 'gvisor',
      };

      testHelpers.presetSidecarIpEnvVars(environment, config, mockNetworkConfig);

      expect(environment.AWF_SKIP_IPTABLES_INIT).toBe('1');
      // gVisor is not network-isolation (topology) mode
      expect(environment.AWF_NETWORK_ISOLATION).toBeUndefined();
    });
  });

  describe('filterAgentVolumesForSysroot', () => {
    it('drops workdir, home dot-dir, and sysroot-shadowed mounts', () => {
      const config: WrapperConfig = {
        ...baseConfig,
        workDir: '/tmp/awf-work',
      };

      const filtered = testHelpers.filterAgentVolumesForSysroot(
        [
          '/usr:/host/usr:ro',
          '/tmp/awf-work/squid-logs:/var/log/squid:rw',
          '/home/runner/.cache:/host/home/runner/.cache:rw',
          '/home/runner:/host/home/runner:rw',
          '/home/runner/_work/_temp/gh-aw:/host/home/runner/_work/_temp/gh-aw:rw',
          '/tmp:/tmp:rw',
          '/dev/null:/host/home/runner/.npmrc:ro',
          'bad-volume-entry',
        ],
        config,
        '/home/runner',
      );

      expect(filtered).toEqual([
        '/home/runner/_work/_temp/gh-aw:/host/home/runner/_work/_temp/gh-aw:rw',
        '/tmp:/tmp:rw',
        '/dev/null:/host/home/runner/.npmrc:ro',
        'bad-volume-entry',
      ]);
    });
  });
});
