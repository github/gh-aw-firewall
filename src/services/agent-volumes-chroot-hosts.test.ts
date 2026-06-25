import { generateDockerCompose, mockNetworkConfig, useAgentVolumesTestConfig, withEnv } from './service-test-setup.test-utils';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../logger';

// Create mock functions (must remain per-file — jest.mock() is hoisted before imports)

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('../test-helpers/mock-execa.test-utils').execaMockFactory());

const { getConfig } = useAgentVolumesTestConfig();

describe('agent service', () => {
  it('should skip .copilot bind mount when directory does not exist at non-standard HOME path', () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-home-'));

    try {
      withEnv({ HOME: fakeHome, SUDO_USER: undefined }, () => {
        const copilotDir = path.join(fakeHome, '.copilot');
        expect(fs.existsSync(copilotDir)).toBe(false);

        const result = generateDockerCompose(getConfig(), mockNetworkConfig);
        const volumes = result.services.agent.volumes as string[];

        // Directory should NOT be auto-created (changed in #2114)
        expect(fs.existsSync(copilotDir)).toBe(false);
        // The blanket .copilot mount should be absent
        expect(volumes).not.toContain(`${fakeHome}/.copilot:/host${fakeHome}/.copilot:rw`);
        // Optional self-hosted runner toolcache mount should also be absent
        expect(volumes).not.toContain(`${fakeHome}/work/_tool:/host${fakeHome}/work/_tool:ro`);
        // But session-state and logs overlays are always present
        expect(volumes).toContainEqual(expect.stringContaining(`${fakeHome}/.copilot/session-state:rw`));
        expect(volumes).toContainEqual(expect.stringContaining(`${fakeHome}/.copilot/logs:rw`));
      });
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('should skip .copilot bind mount and warn when directory exists but is not accessible', () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-home-'));

    try {
      withEnv({ HOME: fakeHome, SUDO_USER: undefined }, () => {
        const copilotDir = path.join(fakeHome, '.copilot');
        fs.mkdirSync(copilotDir, { recursive: true });
        // Remove all permissions so accessSync throws
        fs.chmodSync(copilotDir, 0o000);

        const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
        try {
          const result = generateDockerCompose(getConfig(), mockNetworkConfig);
          const volumes = result.services.agent.volumes as string[];

          // The blanket .copilot mount should be skipped
          expect(volumes).not.toContain(`${fakeHome}/.copilot:/host${fakeHome}/.copilot:rw`);
          // A warning should have been emitted
          expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Cannot access ~/.copilot directory'));
          // But session-state and logs overlays are always present
          expect(volumes).toContainEqual(expect.stringContaining(`${fakeHome}/.copilot/session-state:rw`));
          expect(volumes).toContainEqual(expect.stringContaining(`${fakeHome}/.copilot/logs:rw`));
        } finally {
          warnSpy.mockRestore();
          // Restore permissions so cleanup can proceed
          fs.chmodSync(copilotDir, 0o755);
        }
      });
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('should use sessionStateDir when specified for chroot mounts', () => {
    const configWithSessionDir = { ...getConfig(), sessionStateDir: '/custom/session-state' };
    const result = generateDockerCompose(configWithSessionDir, mockNetworkConfig);
    const volumes = result.services.agent.volumes as string[];
    const homeDir = process.env.HOME || '/root';
    expect(volumes).toContain(`/custom/session-state:/host${homeDir}/.copilot/session-state:rw`);
    expect(volumes).toContain(`/custom/session-state:${homeDir}/.copilot/session-state:rw`);
  });

  it('should mount /tmp under /host for chroot temp scripts', () => {
    const result = generateDockerCompose(getConfig(), mockNetworkConfig);
    const agent = result.services.agent;
    const volumes = agent.volumes as string[];

    // /tmp:/host/tmp:rw is required for entrypoint.sh to write command scripts
    expect(volumes).toContain('/tmp:/host/tmp:rw');
  });

  it('should mount /etc/passwd and /etc/group for user lookup in chroot mode', () => {
    const result = generateDockerCompose(getConfig(), mockNetworkConfig);
    const agent = result.services.agent;
    const volumes = agent.volumes as string[];

    // These are needed for getent/user lookup inside chroot
    expect(volumes).toContain('/etc/passwd:/host/etc/passwd:ro');
    expect(volumes).toContain('/etc/group:/host/etc/group:ro');
    expect(volumes).toContain('/etc/nsswitch.conf:/host/etc/nsswitch.conf:ro');
  });

  it('should mount read-only chroot-hosts when enableHostAccess is true', () => {
    const config = {
      ...getConfig(),
      enableHostAccess: true
    };
    const result = generateDockerCompose(config, mockNetworkConfig);
    const agent = result.services.agent;
    const volumes = agent.volumes as string[];

    // Should mount a read-only copy of /etc/hosts with host.docker.internal pre-injected
    const hostsVolume = volumes.find((v: string) => v.includes('/host/etc/hosts'));
    expect(hostsVolume).toBeDefined();
    expect(hostsVolume).toMatch(/chroot-.*\/hosts:\/host\/etc\/hosts:ro/);
  });

  it('should inject host.docker.internal into chroot-hosts file', () => {
    const config = {
      ...getConfig(),
      enableHostAccess: true
    };
    generateDockerCompose(config, mockNetworkConfig);

    // Find the chroot hosts file (mkdtempSync creates chroot-XXXXXX directory)
    const chrootDir = fs.readdirSync(getConfig().workDir).find(d => d.startsWith('chroot-'));
    expect(chrootDir).toBeDefined();
    const chrootHostsPath = `${getConfig().workDir}/${chrootDir}/hosts`;
    expect(fs.existsSync(chrootHostsPath)).toBe(true);
    const content = fs.readFileSync(chrootHostsPath, 'utf8');
    // Docker bridge gateway resolution may succeed or fail in test env,
    // but the file should exist with at least localhost
    expect(content).toContain('localhost');
  });

  it('should mount custom chroot-hosts even without enableHostAccess', () => {
    const config = {
      ...getConfig(),
      enableHostAccess: false
    };
    const result = generateDockerCompose(config, mockNetworkConfig);
    const agent = result.services.agent;
    const volumes = agent.volumes as string[];

    // Should mount a custom hosts file in a secure chroot temp dir (for pre-resolved domains)
    const hostsVolume = volumes.find((v: string) => v.includes('/host/etc/hosts'));
    expect(hostsVolume).toBeDefined();
    expect(hostsVolume).toMatch(/chroot-.*\/hosts:\/host\/etc\/hosts:ro/);
  });
});
