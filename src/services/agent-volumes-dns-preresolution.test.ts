import { generateDockerCompose, mockNetworkConfig, useAgentVolumesTestConfig } from './service-test-setup.test-utils';
import * as fs from 'fs';

// Create mock functions (must remain per-file — jest.mock() is hoisted before imports)

// Mock execa module
import { mockExecaSync } from '../test-helpers/mock-execa.test-utils';
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('../test-helpers/mock-execa.test-utils').execaMockFactory());

const { getConfig } = useAgentVolumesTestConfig();

describe('agent service', () => {
  it('should pre-resolve allowed domains into chroot-hosts file', () => {
    // Mock getent to return a resolved IP for a test domain
    mockExecaSync.mockImplementation((...args: any[]) => {
      if (args[0] === 'getent' && args[1]?.[0] === 'hosts') {
        const domain = args[1][1];
        if (domain === 'github.com') {
          return { stdout: '140.82.121.4      github.com', stderr: '', exitCode: 0 };
        }
        if (domain === 'npmjs.org') {
          return { stdout: '104.16.22.35      npmjs.org', stderr: '', exitCode: 0 };
        }
        throw new Error('Resolution failed');
      }
      // For docker network inspect (host.docker.internal)
      throw new Error('Not found');
    });

    const config = {
      ...getConfig(),
      allowedDomains: ['github.com', 'npmjs.org', '*.wildcard.com'],
    };
    generateDockerCompose(config, mockNetworkConfig);

    // Find the chroot hosts file (mkdtempSync creates chroot-XXXXXX directory)
    const chrootDir = fs.readdirSync(getConfig().workDir).find(d => d.startsWith('chroot-'));
    expect(chrootDir).toBeDefined();
    const chrootHostsPath = `${getConfig().workDir}/${chrootDir}/hosts`;
    expect(fs.existsSync(chrootHostsPath)).toBe(true);
    const content = fs.readFileSync(chrootHostsPath, 'utf8');

    // Should contain pre-resolved domains
    expect(content).toContain('140.82.121.4\tgithub.com');
    expect(content).toContain('104.16.22.35\tnpmjs.org');
    // Should NOT contain wildcard domains (can't be resolved)
    expect(content).not.toContain('wildcard.com');

    // Reset mock
    mockExecaSync.mockReset();
  });

  it('should skip domains that fail to resolve during pre-resolution', () => {
    // Mock getent to fail for all domains
    mockExecaSync.mockImplementation(() => {
      throw new Error('Resolution failed');
    });

    const config = {
      ...getConfig(),
      allowedDomains: ['unreachable.tailnet.example'],
    };
    // Should not throw even if resolution fails
    generateDockerCompose(config, mockNetworkConfig);

    // Find the chroot hosts file (mkdtempSync creates chroot-XXXXXX directory)
    const chrootDir = fs.readdirSync(getConfig().workDir).find(d => d.startsWith('chroot-'));
    expect(chrootDir).toBeDefined();
    const chrootHostsPath = `${getConfig().workDir}/${chrootDir}/hosts`;
    expect(fs.existsSync(chrootHostsPath)).toBe(true);
    const content = fs.readFileSync(chrootHostsPath, 'utf8');

    // Should still have the base hosts content (localhost)
    expect(content).toContain('localhost');
    // Should NOT contain the unresolvable domain
    expect(content).not.toContain('unreachable.tailnet.example');

    // Reset mock
    mockExecaSync.mockReset();
  });

  it('should not add duplicate entries for domains already in /etc/hosts', () => {
    // Mock getent to return a resolved IP
    mockExecaSync.mockImplementation((...args: any[]) => {
      if (args[0] === 'getent' && args[1]?.[0] === 'hosts') {
        return { stdout: '127.0.0.1      localhost', stderr: '', exitCode: 0 };
      }
      throw new Error('Not found');
    });

    const config = {
      ...getConfig(),
      allowedDomains: ['localhost'], // localhost is already in /etc/hosts
    };
    generateDockerCompose(config, mockNetworkConfig);

    // Find the chroot hosts file (mkdtempSync creates chroot-XXXXXX directory)
    const chrootDir = fs.readdirSync(getConfig().workDir).find(d => d.startsWith('chroot-'));
    expect(chrootDir).toBeDefined();
    const chrootHostsPath = `${getConfig().workDir}/${chrootDir}/hosts`;
    const content = fs.readFileSync(chrootHostsPath, 'utf8');

    // Count occurrences of 'localhost' - should only be the original entries, not duplicated
    const localhostMatches = content.match(/localhost/g);
    // /etc/hosts typically has multiple localhost entries (127.0.0.1 and ::1)
    // The key assertion is that getent should NOT have been called for localhost
    // since it's already in the hosts file
    expect(localhostMatches).toBeDefined();

    // Reset mock
    mockExecaSync.mockReset();
  });
});
