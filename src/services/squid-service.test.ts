import { generateDockerCompose, WrapperConfig, baseConfig, mockNetworkConfig, useTempWorkDir } from './service-test-setup.test-utils';

// Create mock functions (must remain per-file — jest.mock() is hoisted before imports)

// Mock execa module
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('../test-helpers/mock-execa.test-utils').execaMockFactory());

let mockConfig: WrapperConfig;

describe('squid service', () => {
  useTempWorkDir(
    baseConfig,
    (config) => {
      mockConfig = config;
    },
    () => mockConfig
  );

    it('should configure squid container correctly', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const squid = result.services['squid-proxy'];

      expect(squid.container_name).toBe('awf-squid');
      // squid.conf is NOT bind-mounted; it's injected via AWF_SQUID_CONFIG_B64 env var
      expect(squid.volumes).not.toContainEqual(expect.stringContaining('squid.conf'));
      expect(squid.volumes).toContain(`${mockConfig.workDir}/squid-logs:/var/log/squid:rw`);
      expect(squid.healthcheck).toBeDefined();
      expect(squid.ports).toContain('3128:3128');
    });

    it('should set stop_grace_period on squid service', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const squid = result.services['squid-proxy'] as any;
      expect(squid.stop_grace_period).toBe('2s');
    });

    it('should inject squid config via base64 env var when content is provided', () => {
      const squidConfig = 'http_port 3128\nacl allowed_domains dstdomain .github.com\n';
      const result = generateDockerCompose(mockConfig, mockNetworkConfig, undefined, squidConfig);
      const squid = result.services['squid-proxy'] as any;

      // Should have AWF_SQUID_CONFIG_B64 env var with base64-encoded config
      expect(squid.environment.AWF_SQUID_CONFIG_B64).toBe(
        Buffer.from(squidConfig).toString('base64')
      );

      // Should override entrypoint to decode config before starting squid
      expect(squid.entrypoint).toBeDefined();
      expect(squid.entrypoint[2]).toContain('base64 -d > /etc/squid/squid.conf');
      expect(squid.entrypoint[2]).toContain('entrypoint.sh');
    });

    // Regression: on split runner/Docker daemon filesystems (ARC + DinD), Docker
    // auto-creates missing bind-mount source dirs on the daemon side as root-owned.
    // The bind-mount then overrides the Dockerfile-baked /var/log/squid (proxy-
    // owned), and squid (UID 13) exits 1 the first time it tries to open
    // access.log. The squid service must therefore start as root, chown the
    // bind-mounted dir back to the proxy user, and drop privileges before squid
    // runs.
    it('should run squid container as root with a chown preflight that drops privileges', () => {
      const squidConfig = 'http_port 3128\n';
      const result = generateDockerCompose(mockConfig, mockNetworkConfig, undefined, squidConfig);
      const squid = result.services['squid-proxy'] as any;

      // The compose service must start as root so the preflight can chown
      // bind-mounted paths it does not own.
      expect(squid.user).toBe('0:0');

      const inlineScript: string = squid.entrypoint[2];
      // Non-recursive chown on the dir only (NOT chown -R), so the preflight
      // does not traverse a potentially large user-supplied proxyLogsDir.
      expect(inlineScript).toMatch(/(^|[^R])chown proxy:proxy \/var\/log\/squid/);
      expect(inlineScript).not.toContain('chown -R');
      // The SSL DB chown is conditional on the dir existing so it is a no-op
      // when SSL Bump is disabled but engages automatically when it is enabled.
      // Falls back to chmod 0777 if chown is denied (tolerant, like config-writer.ts).
      expect(inlineScript).toContain('if [ -d /var/spool/squid_ssl_db ]; then chown proxy:proxy /var/spool/squid_ssl_db 2>/dev/null || chmod 0777 /var/spool/squid_ssl_db; fi');
      // Privileges must drop before squid itself starts. We use su (always
      // present in the ubuntu/squid base) rather than gosu or runuser.
      expect(inlineScript).toContain('exec su -s /bin/bash proxy -c');

      // The chown must precede the privilege drop.
      const chownIdx = inlineScript.indexOf('chown proxy:proxy /var/log/squid');
      const suIdx = inlineScript.indexOf('exec su -s /bin/bash proxy -c');
      expect(chownIdx).toBeGreaterThanOrEqual(0);
      expect(suIdx).toBeGreaterThan(chownIdx);
    });

    // The chown preflight is required regardless of whether squid config is
    // injected, because the daemon-side ownership problem is independent of
    // the config-injection mechanism.
    it('should apply the chown preflight even when no squid config content is provided', () => {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const squid = result.services['squid-proxy'] as any;

      expect(squid.user).toBe('0:0');
      expect(squid.entrypoint).toBeDefined();
      const inlineScript: string = squid.entrypoint[2];
      expect(inlineScript).toContain('chown proxy:proxy /var/log/squid');
      expect(inlineScript).not.toContain('chown -R');
      expect(inlineScript).toContain('exec su -s /bin/bash proxy -c');
      // Without injected config, the entrypoint should still hand off to the
      // image's original entrypoint script (which handles IPv6 stripping etc.).
      expect(inlineScript).toContain('/usr/local/bin/entrypoint.sh');
      // And it should NOT attempt to decode an AWF_SQUID_CONFIG_B64 that
      // would be unset.
      expect(inlineScript).not.toContain('AWF_SQUID_CONFIG_B64');
    });
});
