import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildEtcMounts } from './etc-mounts';
import { WrapperConfig } from '../../types';
import * as hostIdentity from '../../host-identity';

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
      jest.restoreAllMocks();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('stages /etc/passwd when it exists on the runner', () => {
      const config = createMinimalConfig({
        dockerHostPathPrefix: '/tmp/awf-dind-prefix',
        workDir: tmpDir,
      });
      const mounts = buildEtcMounts(config);
      // Should have passwd and group mounts (either staged or synthesized)
      const passwdMount = mounts.find(m => m.includes('/host/etc/passwd'));
      expect(passwdMount).toBeDefined();
      expect(passwdMount!.startsWith('/etc/passwd:')).toBe(false);
      expect(passwdMount).toContain(':ro');
    });

    it('produces passwd and group mounts in DinD mode', () => {
      const workDir = path.join(tmpDir, 'work');
      fs.mkdirSync(workDir, { recursive: true });
      const config = createMinimalConfig({
        dockerHostPathPrefix: '/tmp/awf-dind-prefix',
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

    it('supplements staged passwd/group files when UID/GID are missing', () => {
      const uid = '424242';
      const gid = '434343';
      jest.spyOn(hostIdentity, 'getSafeHostUid').mockReturnValue(uid);
      jest.spyOn(hostIdentity, 'getSafeHostGid').mockReturnValue(gid);

      const config = createMinimalConfig({
        dockerHostPathPrefix: '/tmp/awf-dind-prefix',
        workDir: tmpDir,
      });

      const mounts = buildEtcMounts(config);
      const passwdPath = mounts.find(m => m.includes('/host/etc/passwd'))!.split(':')[0];
      const groupPath = mounts.find(m => m.includes('/host/etc/group'))!.split(':')[0];

      expect(fs.readFileSync(passwdPath, 'utf8')).toContain(`runner:x:${uid}:${gid}:`);
      expect(fs.readFileSync(groupPath, 'utf8')).toContain(`runner:x:${gid}:`);
    });
  });
});
