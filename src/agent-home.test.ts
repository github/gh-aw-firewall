import fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveAgentHome } from './agent-home';
import { getRealUserHome } from './host-identity';
import { buildConfig } from './commands/build-config';
import { buildMinimalBuildConfigInput } from './test-helpers/build-config.test-utils';

describe('agent home override', () => {
  let home: string;
  let sudoUid: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-private-home-'));
    sudoUid = process.env.SUDO_UID;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (sudoUid === undefined) delete process.env.SUDO_UID;
    else process.env.SUDO_UID = sudoUid;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('preserves sudo-aware runner home selection by default', () => {
    expect(resolveAgentHome({})).toBe(getRealUserHome());
  });

  it('resolves --home during CLI configuration assembly without changing the host HOME', () => {
    const hostHome = process.env.HOME;
    const inputs = buildMinimalBuildConfigInput();
    const config = buildConfig({
      ...inputs,
      options: { ...inputs.options, home: `${home}/.` },
    });
    expect(config.homeDir).toBe(fs.realpathSync(home));
    expect(process.env.HOME).toBe(hostHome);
  });

  it('uses the injected environment for --home ownership during configuration assembly', () => {
    const stat = fs.statSync(home);
    jest.spyOn(process, 'getuid').mockReturnValue(0);
    jest.spyOn(fs, 'statSync').mockReturnValue(Object.assign(stat, { uid: 2001 }));
    process.env.SUDO_UID = '2001';
    const inputs = buildMinimalBuildConfigInput();
    const configInputs = { ...inputs, options: { ...inputs.options, home } };

    expect(() => buildConfig(configInputs, {})).toThrow(/not owned by the invoking user/);
    expect(() => buildConfig(configInputs, { SUDO_UID: '2002' })).toThrow(/not owned by the invoking user/);
    expect(buildConfig(configInputs, { SUDO_UID: '2001' }).homeDir).toBe(fs.realpathSync(home));
    expect(buildConfig(configInputs).homeDir).toBe(fs.realpathSync(home));
  });

  it.each(['relative/home', '/', '/tmp/invalid:home', '/tmp/invalid\nhome'])(
    'rejects unsafe home path %j',
    (homeDir) => {
      expect(() => resolveAgentHome({ homeDir })).toThrow(/--home/);
    },
  );

  it('requires an existing writable directory and reports the failing path', () => {
    const missing = path.join(home, 'missing');
    expect(() => resolveAgentHome({ homeDir: missing })).toThrow(missing);
    fs.writeFileSync(path.join(home, 'file'), '');
    expect(() => resolveAgentHome({ homeDir: path.join(home, 'file') })).toThrow('not a directory');
    jest.spyOn(fs, 'accessSync').mockImplementation(() => {
      throw Object.assign(new Error(`EACCES: ${home}`), { code: 'EACCES' });
    });
    expect(() => resolveAgentHome({ homeDir: home })).toThrow(/root-squash.*--home/);
  });

  it.each([0o720, 0o702, 0o722])('rejects home with writable group or other mode %s', (mode) => {
    fs.chmodSync(home, mode);
    expect(() => resolveAgentHome({ homeDir: home })).toThrow(/writable by group or other/);
  });

  it.each([0o700, 0o750, 0o755])('accepts home with safe mode %s', (mode) => {
    fs.chmodSync(home, mode);
    expect(resolveAgentHome({ homeDir: home })).toBe(fs.realpathSync(home));
  });

  it.each(['.ssh', '.gnupg', '.aws', '.config/op', '.config/heroku', '.local/state/sandboxes'])(
    'rejects an existing unmaskable credential directory %s',
    (relative) => {
      fs.mkdirSync(path.join(home, relative), { recursive: true });
      expect(() => resolveAgentHome({ homeDir: home }))
        .toThrow('unmaskable credential directory');
    },
  );

  it.each([
    { effectiveUid: 1001, sudoUid: '2001', owner: 1001, accepted: true },
    { effectiveUid: 1001, sudoUid: '2001', owner: 2001, accepted: false },
    { effectiveUid: 0, sudoUid: '2001', owner: 0, accepted: true },
    { effectiveUid: 0, sudoUid: '2001', owner: 2001, accepted: true },
    { effectiveUid: 0, sudoUid: '2001', owner: 2002, accepted: false },
    { effectiveUid: 0, sudoUid: 'invalid', owner: 2001, accepted: false },
    { effectiveUid: 0, sudoUid: '-1', owner: 2001, accepted: false },
  ])('checks trusted owners: %j', ({ effectiveUid, sudoUid: sudo, owner, accepted }) => {
    const stat = fs.statSync(home);
    jest.spyOn(process, 'getuid').mockReturnValue(effectiveUid);
    jest.spyOn(fs, 'statSync').mockReturnValue(Object.assign(stat, { uid: owner }));
    process.env.SUDO_UID = sudo;
    if (accepted) expect(resolveAgentHome({ homeDir: home })).toBe(fs.realpathSync(home));
    else expect(() => resolveAgentHome({ homeDir: home })).toThrow(/not owned by the invoking user/);
  });

  it('checks the resolved target of a symlink', () => {
    const link = path.join(home, 'link');
    fs.symlinkSync(home, link);
    fs.chmodSync(home, 0o777);
    expect(() => resolveAgentHome({ homeDir: link })).toThrow(/writable by group or other/);
  });

  it.each(['sbx', 'cloud-hypervisor', 'nvx'])('rejects unsupported runtime %s', (containerRuntime) => {
    expect(() => resolveAgentHome({ homeDir: home, containerRuntime })).toThrow('Compose agents');
  });

  it('rejects ARC/DinD sysroot staging and conflicting chroot identity homes', () => {
    expect(() => resolveAgentHome({ homeDir: home, runnerTopology: 'arc-dind' })).toThrow('ARC/DinD');
    expect(() => resolveAgentHome({ homeDir: home, chrootIdentity: { home: '/different' } }))
      .toThrow('chroot.identity.home');
  });
});
