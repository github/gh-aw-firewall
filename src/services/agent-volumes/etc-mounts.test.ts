import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildEtcMounts } from './etc-mounts';
import { WrapperConfig } from '../../types';
import * as hostIdentity from '../../host-identity';
import * as dockerHostStaging from './docker-host-staging';

function createMinimalConfig(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    allowDomains: 'example.com',
    agentCommand: 'echo test',
    workDir: '/tmp/awf-test',
    ...overrides,
  } as WrapperConfig;
}

describe('buildEtcMounts', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('sysroot gating by runnerTopology', () => {
    it('returns empty array when runnerTopology is arc-dind (sysroot provides /etc)', () => {
      const config = createMinimalConfig({ runnerTopology: 'arc-dind' });
      const mounts = buildEtcMounts(config);
      expect(mounts).toEqual([]);
    });

    it('still mounts /etc files when runnerTopology is standard', () => {
      const config = createMinimalConfig({ runnerTopology: 'standard' });
      const mounts = buildEtcMounts(config);
      expect(mounts.length).toBeGreaterThan(0);
      expect(mounts).toContain('/etc/ld.so.cache:/host/etc/ld.so.cache:ro');
    });

    it('still mounts /etc files when runnerTopology is undefined', () => {
      const config = createMinimalConfig({ runnerTopology: undefined });
      const mounts = buildEtcMounts(config);
      expect(mounts.length).toBeGreaterThan(0);
      expect(mounts).toContain('/etc/ld.so.cache:/host/etc/ld.so.cache:ro');
    });
  });

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
      if (fs.existsSync('/etc/pki/ca-trust/extracted')) {
        expect(mounts).toContain('/etc/pki/ca-trust/extracted:/host/etc/pki/ca-trust/extracted:ro');
      } else {
        expect(mounts).not.toContain('/etc/pki/ca-trust/extracted:/host/etc/pki/ca-trust/extracted:ro');
      }
      if (fs.existsSync('/etc/pki/tls/certs')) {
        expect(mounts).toContain('/etc/pki/tls/certs:/host/etc/pki/tls/certs:ro');
      } else {
        expect(mounts).not.toContain('/etc/pki/tls/certs:/host/etc/pki/tls/certs:ro');
      }
      expect(mounts).toContain('/etc/nsswitch.conf:/host/etc/nsswitch.conf:ro');
    });

    it('omits optional RHEL CA mounts when host sources are unavailable', () => {
      if (fs.existsSync('/etc/pki/ca-trust/extracted') || fs.existsSync('/etc/pki/tls/certs')) {
        return;
      }
      const config = createMinimalConfig({ dockerHostPathPrefix: undefined });
      const mounts = buildEtcMounts(config);
      expect(mounts).not.toContain('/etc/pki/ca-trust/extracted:/host/etc/pki/ca-trust/extracted:ro');
      expect(mounts).not.toContain('/etc/pki/tls/certs:/host/etc/pki/tls/certs:ro');
    });

    it('keeps optional RHEL CA mounts when split-fs prefixed sources exist', () => {
      const prefixRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-prefix-'));
      try {
        fs.mkdirSync(path.join(prefixRoot, 'etc/pki/ca-trust/extracted'), { recursive: true });
        fs.mkdirSync(path.join(prefixRoot, 'etc/pki/tls/certs'), { recursive: true });
        const config = createMinimalConfig({ dockerHostPathPrefix: prefixRoot });
        const mounts = buildEtcMounts(config);
        expect(mounts).toContain('/etc/pki/ca-trust/extracted:/host/etc/pki/ca-trust/extracted:ro');
        expect(mounts).toContain('/etc/pki/tls/certs:/host/etc/pki/tls/certs:ro');
      } finally {
        fs.rmSync(prefixRoot, { recursive: true, force: true });
      }
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

      expect(fs.readFileSync(passwdPath, 'utf8')).toMatch(new RegExp(`^[^:]+:x:${uid}:${gid}:`, 'm'));
      expect(fs.readFileSync(groupPath, 'utf8')).toMatch(new RegExp(`^[^:]+:x:${gid}:`, 'm'));
    });
    it('avoids runner name collisions and reuses deterministic identity staging paths', () => {
      const uid = '424242';
      const gid = '434343';
      const stageRoot = path.join(tmpDir, 'staged-identities');
      const stagedPasswd = path.join(stageRoot, 'etc', 'passwd');
      const stagedGroup = path.join(stageRoot, 'etc', 'group');

      fs.mkdirSync(path.dirname(stagedPasswd), { recursive: true });
      fs.writeFileSync(
        stagedPasswd,
        [
          'root:x:0:0:root:/root:/bin/bash',
          'runner:x:1000:1000:Runner:/home/runner:/bin/bash',
        ].join('\n') + '\n'
      );
      fs.writeFileSync(
        stagedGroup,
        [
          'root:x:0:',
          'runner:x:1000:',
        ].join('\n') + '\n'
      );

      jest.spyOn(hostIdentity, 'getSafeHostUid').mockReturnValue(uid);
      jest.spyOn(hostIdentity, 'getSafeHostGid').mockReturnValue(gid);
      jest.spyOn(dockerHostStaging, 'shouldUseDockerHostStaging').mockReturnValue(true);
      jest.spyOn(dockerHostStaging, 'getDockerHostStageRoot').mockReturnValue(stageRoot);
      jest.spyOn(dockerHostStaging, 'stageHostFile').mockImplementation((_config, sourcePath) => {
        if (sourcePath === '/etc/passwd') return stagedPasswd;
        if (sourcePath === '/etc/group') return stagedGroup;
        return undefined;
      });

      const config = createMinimalConfig({
        dockerHostPathPrefix: '/tmp/awf-dind-prefix',
        workDir: tmpDir,
      });
      const mounts = buildEtcMounts(config);
      const passwdPath = mounts.find(m => m.includes('/host/etc/passwd'))!.split(':')[0];
      const groupPath = mounts.find(m => m.includes('/host/etc/group'))!.split(':')[0];
      const passwdContent = fs.readFileSync(passwdPath, 'utf8');
      const groupContent = fs.readFileSync(groupPath, 'utf8');

      expect((passwdContent.match(/^runner:/gm) || []).length).toBe(1);
      expect(passwdContent).toContain(`runner-${uid}:x:${uid}:${gid}:`);
      expect((groupContent.match(/^runner:/gm) || []).length).toBe(1);
      expect(groupContent).toContain(`runner-${gid}:x:${gid}:`);
      expect(path.dirname(passwdPath)).toBe(path.join(stageRoot, 'identity'));
      expect(path.dirname(groupPath)).toBe(path.join(stageRoot, 'identity'));
    });
  });
});
