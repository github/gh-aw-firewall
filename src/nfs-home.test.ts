import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { stageNfsHome, usesNfsHome } from './nfs-home';
import { prepareChrootHomeMounts } from './chroot-home-setup';
import { buildHomeMounts } from './services/agent-volumes/home-strategy';
import { buildCredentialHidingOverlays, pruneUnmountableCredentialOverlays } from './services/agent-volumes/credential-hiding';
import { CREDENTIAL_ENTRIES } from './config/mount-policy';
import { WrapperConfig } from './types';

jest.mock('fs', () => ({ __esModule: true, ...jest.requireActual('fs') }));

(process.platform === 'linux' ? describe : describe.skip)('NFS agent home', () => {
  let root: string;
  let home: string;
  let config: WrapperConfig;
  const actualFs = jest.requireActual<typeof fs>('fs');

  beforeEach(() => {
    jest.replaceProperty(process, 'env', { ...process.env, RUNNER_TOOL_CACHE: '' });
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-nfs-home-'));
    home = path.join(root, 'nfs-home');
    fs.mkdirSync(home, { mode: 0o700 });
    config = {
      workDir: path.join(root, 'work'), agentCommand: 'true', allowedDomains: [],
      logLevel: 'info', keepContainers: false, buildLocal: false,
      imageRegistry: 'ghcr.io/github/gh-aw-firewall', imageTag: 'latest',
    };
    jest.spyOn(fs, 'statfsSync').mockImplementation((candidate) => ({
      ...actualFs.statfsSync(root),
      type: actualFs.realpathSync(candidate).startsWith(home) ? 0x6969 : 0xef53,
    }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(`${config.workDir}-chroot-home`, { recursive: true, force: true });
  });

  function write(relative: string, contents = 'synthetic fixture'): string {
    const file = path.join(home, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, contents);
    return file;
  }

  it('detects NFS without changing local-home or ARC/DinD behavior', () => {
    expect(usesNfsHome(config, home)).toBe(true);
    expect(usesNfsHome({ ...config, containerRuntime: 'gvisor' }, home)).toBe(true);
    expect(usesNfsHome(config, root)).toBe(false);
    expect(usesNfsHome({ ...config, runnerTopology: 'arc-dind' }, home)).toBe(false);
    expect(usesNfsHome({ ...config, containerRuntime: 'cloud-hypervisor' }, home)).toBe(false);
    (fs.statfsSync as jest.Mock).mockImplementation(() => {
      throw Object.assign(new Error('missing home'), { code: 'ENOENT' });
    });
    expect(usesNfsHome(config, '/missing-home')).toBe(false);
  });

  it('starts from a local mount tree without creating or masking credential paths on NFS', () => {
    write('.config/glab-cli/config.yml');
    write('.config/gh/hosts.yml');
    write('.claude/settings.json', '{"safe":true}');
    write('.local/bin/tool', '#!/bin/sh\nexit 0\n');
    write('work/_tool/node/bin/node', 'tool-cache fixture');
    fs.chmodSync(path.join(home, '.local/bin/tool'), 0o755);
    const before = fs.readdirSync(home, { recursive: true });
    const mkdir = jest.spyOn(fs, 'mkdirSync').mockImplementation((candidate, options) => {
      if (String(candidate).startsWith(home)) {
        throw Object.assign(new Error('NFS mount target is uncreatable'), { code: 'EACCES' });
      }
      return actualFs.mkdirSync(candidate, options);
    });
    const chown = jest.spyOn(fs, 'chownSync');
    const fchown = jest.spyOn(fs, 'fchownSync');
    jest.spyOn(process, 'getuid').mockReturnValue(1001);
    jest.spyOn(process, 'getgid').mockReturnValue(1001);
    // Keep ownership assertions independent of the test process's actual UID.
    chown.mockImplementation(() => undefined);
    fchown.mockImplementation(() => undefined);
    const env = jest.replaceProperty(process, 'env', { ...process.env, HOME: home });

    prepareChrootHomeMounts(config);
    const destination = `${config.workDir}-chroot-home`;
    const volumes = buildHomeMounts({
      config, effectiveHome: home,
      agentLogsPath: path.join(root, 'logs'),
      sessionStatePath: path.join(root, 'sessions'),
    });
    const overlays = buildCredentialHidingOverlays(home, volumes);
    const finalVolumes = pruneUnmountableCredentialOverlays([...volumes, ...overlays]);

    expect(volumes).toContain(`${destination}:/host${home}:rw`);
    expect(volumes).toContain(`${destination}/work/_tool:/host${home}/work/_tool:ro`);
    expect(volumes.some((volume) => volume.startsWith(`${home}/.`))).toBe(false);
    expect(finalVolumes).not.toContain(`/dev/null:/host${home}/.config/glab-cli/config.yml:ro`);
    expect(fs.existsSync(path.join(destination, '.config/glab-cli'))).toBe(false);
    expect(fs.existsSync(path.join(destination, '.config/gh'))).toBe(false);
    expect(fs.readFileSync(path.join(destination, '.claude/settings.json'), 'utf8')).toBe('{"safe":true}');
    expect(fs.statSync(path.join(destination, '.local/bin/tool')).mode & 0o111).toBe(0o111);
    expect(fs.readFileSync(path.join(destination, 'work/_tool/node/bin/node'), 'utf8')).toBe('tool-cache fixture');
    expect(fs.readdirSync(home, { recursive: true })).toEqual(before);
    expect(chown.mock.calls.every(([target]) => !String(target).startsWith(home))).toBe(true);
    expect(mkdir.mock.calls.some(([target]) => String(target).startsWith(home))).toBe(false);
    env.restore();
  });

  it('excludes the entire credential deny list, GitLab overrides, and proxy env files before copying', () => {
    for (const entry of CREDENTIAL_ENTRIES) {
      write(entry.type === 'dir' ? `${entry.path}/fixture` : entry.path);
    }
    const override = path.dirname(write('.cache/gitlab/config.yml'));
    const envFile = write('.cache/proxy.env');
    const env = jest.replaceProperty(process, 'env', { ...process.env, GLAB_CONFIG_DIR: override });
    const destination = path.join(root, 'snapshot');
    fs.mkdirSync(destination);

    stageNfsHome({ ...config, enableApiProxy: true, envFile, googleApiKey: 'test-key' }, home, destination);

    for (const entry of CREDENTIAL_ENTRIES) {
      expect(fs.existsSync(path.join(destination, entry.path))).toBe(false);
    }
    expect(fs.existsSync(path.join(destination, '.cache/gitlab/config.yml'))).toBe(false);
    expect(fs.existsSync(path.join(destination, '.cache/proxy.env'))).toBe(false);
    env.restore();
  });

  it('preserves tool symlinks without following them or copying canonical credential stores', () => {
    write('.cache/private/hosts.yml');
    fs.mkdirSync(path.join(home, '.config'));
    fs.symlinkSync('../.cache/private', path.join(home, '.config/gh'));
    write('.local/bin/tool');
    fs.symlinkSync('tool', path.join(home, '.local/bin/tool-link'));
    const destination = path.join(root, 'snapshot');
    fs.mkdirSync(destination);

    stageNfsHome(config, home, destination);

    expect(fs.existsSync(path.join(destination, '.cache/private'))).toBe(false);
    expect(fs.readlinkSync(path.join(destination, '.local/bin/tool-link'))).toBe('tool');
  });

  it('does not follow a source entry replaced by a symlink during staging', () => {
    const sourceFile = write('.cache/raced');
    const secret = path.join(root, 'secret');
    fs.writeFileSync(secret, 'must not be staged');
    const destination = path.join(root, 'snapshot');
    fs.mkdirSync(destination);
    let replaced = false;
    const open = jest.spyOn(fs, 'openSync').mockImplementation((candidate, flags, mode) => {
      if (!replaced && String(candidate).startsWith('/proc/self/fd/') && String(candidate).endsWith('/raced')) {
        replaced = true;
        fs.unlinkSync(sourceFile);
        fs.symlinkSync(secret, sourceFile);
      }
      return actualFs.openSync(candidate, flags, mode as number);
    });

    stageNfsHome(config, home, destination);

    expect(replaced).toBe(true);
    expect(fs.existsSync(path.join(destination, '.cache/raced'))).toBe(false);
    open.mockRestore();
  });

  it('skips source entries removed during staging', () => {
    const sourceFile = write('.cache/pruned');
    const destination = path.join(root, 'snapshot');
    fs.mkdirSync(destination);
    let pruned = false;
    const open = jest.spyOn(fs, 'openSync').mockImplementation((candidate, flags, mode) => {
      if (!pruned && String(candidate).startsWith('/proc/self/fd/') && String(candidate).endsWith('/pruned')) {
        pruned = true;
        fs.unlinkSync(sourceFile);
      }
      return actualFs.openSync(candidate, flags, mode as number);
    });

    expect(() => stageNfsHome(config, home, destination)).not.toThrow();

    expect(pruned).toBe(true);
    expect(fs.existsSync(path.join(destination, '.cache/pruned'))).toBe(false);
    open.mockRestore();
  });

  it('excludes symlinked credential file targets even when HOME itself is a symlink', () => {
    const secret = write('.cache/gh-hosts.yml');
    fs.mkdirSync(path.join(home, '.config/gh'), { recursive: true });
    fs.symlinkSync(secret, path.join(home, '.config/gh/hosts.yml'));
    write('.cache/private/config.yml');
    fs.symlinkSync(path.join(home, '.cache/private'), path.join(home, '.config/glab-cli'));
    const homeAlias = path.join(root, 'home-alias');
    fs.symlinkSync(home, homeAlias);
    const destination = path.join(root, 'snapshot');
    fs.mkdirSync(destination);

    stageNfsHome(config, homeAlias, destination);

    expect(fs.existsSync(path.join(destination, '.cache/gh-hosts.yml'))).toBe(false);
    expect(fs.existsSync(path.join(destination, '.cache/private'))).toBe(false);
  });

  it.each([true, false])('uses the sanitized cache with aliased HOME=%s', (aliasHome) => {
    write('work/_tool/private-gh/hosts.yml');
    fs.mkdirSync(path.join(home, '.config'));
    fs.symlinkSync(path.join(home, 'work/_tool/private-gh'), path.join(home, '.config/gh'));
    const alias = path.join(root, 'home-alias');
    fs.symlinkSync(home, alias);
    const effectiveHome = aliasHome ? alias : home;
    const cache = path.join(aliasHome ? home : alias, 'work/_tool');
    config.runnerToolCachePath = cache;
    const destination = `${config.workDir}-chroot-home`;
    fs.mkdirSync(destination);

    stageNfsHome(config, effectiveHome, destination);
    const volumes = buildHomeMounts({
      config, effectiveHome, agentLogsPath: path.join(root, 'logs'),
      sessionStatePath: path.join(root, 'sessions'),
    });

    expect(volumes).toContain(`${destination}/work/_tool:/host${cache}:ro`);
    expect(volumes).toContain(`${destination}/work/_tool:/host${effectiveHome}/work/_tool:ro`);
    expect(volumes).not.toContain(`${cache}:/host${cache}:ro`);
    expect(fs.existsSync(path.join(destination, 'work/_tool/private-gh'))).toBe(false);
  });

  it('copies a cache ancestor only once when it covers an allowlisted tool path', () => {
    write('.local/bin/tool');
    config.runnerToolCachePath = path.join(home, '.local');
    const destination = path.join(root, 'snapshot');
    fs.mkdirSync(destination);

    stageNfsHome(config, home, destination);

    expect(fs.readFileSync(path.join(destination, '.local/bin/tool'), 'utf8')).toBe('synthetic fixture');
  });

  it('rejects NFS staging storage and stale destinations instead of reusing unsafe trees', () => {
    expect(() => stageNfsHome(config, home, home)).toThrow('--work-dir on a local filesystem');
    write('.config/safe');
    const destination = path.join(root, 'snapshot');
    fs.mkdirSync(destination);
    fs.symlinkSync(home, path.join(destination, '.config'));
    expect(() => stageNfsHome(config, home, destination)).toThrow('empty, non-symlink');
    expect(fs.existsSync(path.join(home, 'safe'))).toBe(false);
  });

  it('rejects staging destinations that resolve beneath the canonical home', () => {
    const staging = path.join(home, '.cache/staging');
    fs.mkdirSync(staging, { recursive: true });
    const alias = path.join(root, 'home-cache');
    fs.symlinkSync(path.join(home, '.cache'), alias);

    expect(() => stageNfsHome(config, home, path.join(alias, 'staging')))
      .toThrow('--work-dir outside the host home');
  });

  it('rejects symlinked tool roots instead of following them outside the home allowlist', () => {
    fs.symlinkSync(root, path.join(home, '.cache'));
    const destination = path.join(root, 'snapshot');
    fs.mkdirSync(destination);

    expect(() => stageNfsHome(config, home, destination)).toThrow('must be a real directory');
  });
});
