import fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveAgentHome } from './agent-home';
import { getRealUserHome } from './host-identity';
import { buildConfig } from './commands/build-config';
import { buildMinimalBuildConfigInput } from './test-helpers/build-config.test-utils';

describe('agent home override', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-private-home-'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
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

  it.each(['sbx', 'cloud-hypervisor', 'nvx'])('rejects unsupported runtime %s', (containerRuntime) => {
    expect(() => resolveAgentHome({ homeDir: home, containerRuntime })).toThrow('Compose agents');
  });

  it('rejects ARC/DinD sysroot staging and conflicting chroot identity homes', () => {
    expect(() => resolveAgentHome({ homeDir: home, runnerTopology: 'arc-dind' })).toThrow('ARC/DinD');
    expect(() => resolveAgentHome({ homeDir: home, chrootIdentity: { home: '/different' } }))
      .toThrow('chroot.identity.home');
  });
});
