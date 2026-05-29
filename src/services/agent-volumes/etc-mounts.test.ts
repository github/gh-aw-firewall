import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildEtcMounts } from './etc-mounts';
import { WrapperConfig } from '../../types';

function createMinimalConfig(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    allowDomains: 'example.com',
    agentCommand: 'echo test',
    workDir: '/tmp/awf-test',
    ...overrides,
  } as WrapperConfig;
}

describe('buildEtcMounts', () => {
  describe('non-DinD mode', () => {
    it('mounts /etc/passwd and /etc/group directly', () => {
      const config = createMinimalConfig({ dockerHostPathPrefix: undefined });
      const mounts = buildEtcMounts(config);
      expect(mounts).toContain('/etc/passwd:/host/etc/passwd:ro');
      expect(mounts).toContain('/etc/group:/host/etc/group:ro');
    });

    it('includes standard /etc mounts', () => {
      const config = createMinimalConfig({ dockerHostPathPrefix: undefined });
      const mounts = buildEtcMounts(config);
      expect(mounts).toContain('/etc/ssl:/host/etc/ssl:ro');
      expect(mounts).toContain('/etc/ca-certificates:/host/etc/ca-certificates:ro');
      expect(mounts).toContain('/etc/nsswitch.conf:/host/etc/nsswitch.conf:ro');
    });
  });

  describe('DinD mode with dockerHostPathPrefix', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-etc-mounts-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('stages /etc/passwd when it exists on the runner', () => {
      const config = createMinimalConfig({
        dockerHostPathPrefix: '/host',
        workDir: tmpDir,
      });
      const mounts = buildEtcMounts(config);
      // Should have passwd and group mounts (either staged or synthesized)
      const passwdMount = mounts.find(m => m.includes('/host/etc/passwd'));
      expect(passwdMount).toBeDefined();
      expect(passwdMount).toContain(':ro');
    });

    it('produces passwd and group mounts in DinD mode', () => {
      const workDir = path.join(tmpDir, 'work');
      fs.mkdirSync(workDir, { recursive: true });
      const config = createMinimalConfig({
        dockerHostPathPrefix: '/host',
        workDir,
      });

      const mounts = buildEtcMounts(config);

      const passwdMount = mounts.find(m => m.includes('/host/etc/passwd'));
      const groupMount = mounts.find(m => m.includes('/host/etc/group'));
      expect(passwdMount).toBeDefined();
      expect(groupMount).toBeDefined();

      // In DinD mode, the mount source is a staged file path (not bare /etc/passwd)
      const passwdPath = passwdMount!.split(':')[0];
      expect(fs.existsSync(passwdPath)).toBe(true);

      const groupPath = groupMount!.split(':')[0];
      expect(fs.existsSync(groupPath)).toBe(true);
    });
  });
});
