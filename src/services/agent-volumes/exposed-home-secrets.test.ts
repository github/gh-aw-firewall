import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildExposedHomeSecretOverlays } from './exposed-home-secrets';
import { identityLocalSourceResolver } from './mount-topology';
import { buildAgentVolumes } from './volume-builder';
import { makeAgentVolumeConfig } from './agent-volumes.test-utils';
import * as hostIdentity from '../../host-identity';

jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...actual,
    realpathSync: jest.fn((...args: Parameters<typeof actual.realpathSync>) => actual.realpathSync(...args)),
  };
});
jest.mock('./hosts-file', () => ({
  generateHostsFileMount: () => '/etc/hosts:/host/etc/hosts:ro',
}));

describe('exposed home secret overlays', () => {
  let root: string;
  let runnerHome: string;
  let effectiveHome: string;
  let state: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-home-test-'));
    runnerHome = path.join(root, 'runner');
    effectiveHome = path.join(root, 'effective');
    state = path.join(root, 'session');
    for (const dir of [runnerHome, effectiveHome, state]) fs.mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    const actual = jest.requireActual<typeof import('fs')>('fs');
    (fs.realpathSync as unknown as jest.Mock).mockImplementation(
      (...args: Parameters<typeof actual.realpathSync>) => actual.realpathSync(...args),
    );
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('masks runner and effective home credentials and old Copilot state through each exposed alias', () => {
    for (const home of [runnerHome, effectiveHome]) {
      fs.mkdirSync(path.join(home, '.config/gh'), { recursive: true });
      fs.writeFileSync(path.join(home, '.config/gh/hosts.yml'), 'fixture');
      fs.mkdirSync(path.join(home, '.copilot/session-state'), { recursive: true });
    }
    const alias = path.join(root, 'runner-link');
    fs.symlinkSync(runnerHome, alias);
    const mounts = [
      `${runnerHome}:/host/workspace:rw`,
      `${alias}:/host/alias:ro`,
      `${effectiveHome}:/host/effective:rw`,
    ];
    const overlays = buildExposedHomeSecretOverlays(
      [effectiveHome, runnerHome], mounts, identityLocalSourceResolver, state,
    );
    for (const target of ['/host/workspace', '/host/alias', '/host/effective']) {
      expect(overlays).toContain(`/dev/null:${target}/.config/gh/hosts.yml:ro`);
      expect(overlays).toContain(`${state}:${target}/.copilot/session-state:rw`);
    }
  });

  it('maps a symlinked credential to a separately exposed canonical path', () => {
    const config = path.join(runnerHome, '.config');
    const shared = path.join(root, 'shared');
    fs.mkdirSync(path.join(shared, 'gh'), { recursive: true });
    fs.writeFileSync(path.join(shared, 'gh/hosts.yml'), 'fixture');
    fs.symlinkSync(shared, config);
    const overlays = buildExposedHomeSecretOverlays(
      [runnerHome], [`${config}:/host/config:rw`, `${shared}:/host/alias:rw`],
      identityLocalSourceResolver, state,
    );
    expect(overlays).toContain('/dev/null:/host/config/gh/hosts.yml:ro');
    expect(overlays).toContain('/dev/null:/host/alias/gh/hosts.yml:ro');
  });

  it('does not probe an unexposed runner home', () => {
    const original = jest.requireActual<typeof import('fs')>('fs').realpathSync;
    const spy = jest.spyOn(fs, 'realpathSync').mockImplementation(((candidate: fs.PathLike, ...args: unknown[]) => {
      if (String(candidate).startsWith(runnerHome)) throw new Error('unexposed NFS path probed');
      return (original as (...params: unknown[]) => string)(candidate, ...args);
    }) as typeof fs.realpathSync);
    expect(() => buildExposedHomeSecretOverlays(
      [effectiveHome, runnerHome], [`${effectiveHome}:/host/home:rw`],
      identityLocalSourceResolver, state,
    )).not.toThrow();
    expect(spy.mock.calls.some(([candidate]) => String(candidate).startsWith(runnerHome))).toBe(false);
  });

  it('applies masks after custom mounts override automatic workspace binds', () => {
    jest.spyOn(hostIdentity, 'getRealUserHome').mockReturnValue(runnerHome);
    fs.mkdirSync(path.join(runnerHome, '.config/gh'), { recursive: true });
    fs.writeFileSync(path.join(runnerHome, '.config/gh/hosts.yml'), 'fixture');
    fs.mkdirSync(path.join(runnerHome, '.copilot/session-state'), { recursive: true });
    const config = makeAgentVolumeConfig({
      workDir: path.join(root, 'work'),
      allowedDomains: [],
      volumeMounts: [`${runnerHome}:/alias:rw`],
    });
    const volumes = buildAgentVolumes({
      config,
      effectiveHome,
      workspaceDir: runnerHome,
      projectRoot: root,
      agentLogsPath: path.join(root, 'logs'),
      sessionStatePath: state,
      initSignalDir: path.join(root, 'init'),
      prepareNestedMountpoints: () => [],
    });
    for (const target of [runnerHome, `/host${runnerHome}`, '/host/alias']) {
      expect(volumes).toContain(`/dev/null:${target}/.config/gh/hosts.yml:ro`);
      expect(volumes).toContain(`${state}:${target}/.copilot/session-state:rw`);
    }
  });

  it.each(['.ssh', '.gnupg', '.aws', '.config/op', '.config/heroku', '.local/state/sandboxes'])(
    'fails closed when the alternate home would expose runner %s',
    (secret) => {
      const source = path.join(runnerHome, secret, 'nested');
      expect(() => buildExposedHomeSecretOverlays(
        [effectiveHome, runnerHome], [`${source}:/host/alias:rw`],
        identityLocalSourceResolver, state, runnerHome,
      )).toThrow('Cannot safely expose runner-home credential path');
    },
  );

  it('rejects a workspace equal to the runner home with --home, even before secrets exist', () => {
    jest.spyOn(hostIdentity, 'getRealUserHome').mockReturnValue(runnerHome);
    const config = makeAgentVolumeConfig({
      workDir: path.join(root, 'work'), homeDir: effectiveHome, allowedDomains: [],
    });

    expect(() => buildAgentVolumes({
      config, effectiveHome, workspaceDir: runnerHome, projectRoot: root,
      agentLogsPath: path.join(root, 'logs'), sessionStatePath: state,
      initSignalDir: path.join(root, 'init'), prepareNestedMountpoints: () => [],
    })).toThrow('Cannot safely expose runner-home credential path');
  });

  it('keeps known credentials masked through narrow custom binds with --home', () => {
    jest.spyOn(hostIdentity, 'getRealUserHome').mockReturnValue(runnerHome);
    const workspace = path.join(runnerHome, 'work/repo');
    const gh = path.join(runnerHome, '.config/gh');
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(gh, { recursive: true });
    fs.writeFileSync(path.join(gh, 'hosts.yml'), 'fixture');
    const config = makeAgentVolumeConfig({
      workDir: path.join(root, 'work'), homeDir: effectiveHome, allowedDomains: [],
      volumeMounts: [`${gh}:/gh-alias:ro`],
    });
    const volumes = buildAgentVolumes({
      config, effectiveHome, workspaceDir: workspace, projectRoot: root,
      agentLogsPath: path.join(root, 'logs'), sessionStatePath: state,
      initSignalDir: path.join(root, 'init'), prepareNestedMountpoints: () => [],
    });
    expect(volumes).toContain('/dev/null:/host/gh-alias/hosts.yml:ro');
  });

  it('rejects aliases to a symlinked runner home using an exposed workspace to identify it', () => {
    const physical = path.join(root, 'physical');
    const logical = path.join(root, 'logical');
    fs.mkdirSync(path.join(physical, 'work/repo'), { recursive: true });
    fs.symlinkSync(physical, logical);
    expect(() => buildExposedHomeSecretOverlays(
      [effectiveHome, logical],
      [`${logical}/work/repo:/host/work:rw`, `${physical}:/host/alias:rw`],
      identityLocalSourceResolver, state, logical,
    )).toThrow('Cannot safely expose runner-home credential path');
  });

  it('rejects a direct symlink alias to a symlinked runner home', () => {
    const physical = path.join(root, 'physical');
    const logical = path.join(root, 'logical');
    const alias = path.join(root, 'alias');
    fs.mkdirSync(physical);
    fs.symlinkSync(physical, logical);
    fs.symlinkSync(logical, alias);
    expect(() => buildExposedHomeSecretOverlays(
      [effectiveHome, logical], [`${alias}:/host/alias:rw`],
      identityLocalSourceResolver, state, logical,
    )).toThrow('Cannot safely expose runner-home credential path');
  });

  it('rejects separately bound subdirectories of runner session history', () => {
    const source = path.join(runnerHome, '.copilot/session-state/old-session');
    expect(() => buildExposedHomeSecretOverlays(
      [effectiveHome, runnerHome], [`${source}:/host/old:ro`],
      identityLocalSourceResolver, state, runnerHome,
    )).toThrow('Cannot safely expose a subdirectory of Copilot session history');
  });

  it('permits a narrow workspace under the runner home without inspecting hidden paths', () => {
    const workspace = path.join(runnerHome, 'work/repo');
    fs.mkdirSync(workspace, { recursive: true });
    const original = jest.requireActual<typeof import('fs')>('fs').realpathSync;
    const spy = jest.spyOn(fs, 'realpathSync').mockImplementation(((candidate: fs.PathLike, ...args: unknown[]) => {
      if (String(candidate).startsWith(`${runnerHome}/.`)) throw new Error('hidden path probed');
      return (original as (...params: unknown[]) => string)(candidate, ...args);
    }) as typeof fs.realpathSync);
    expect(() => buildExposedHomeSecretOverlays(
      [effectiveHome, runnerHome], [`${workspace}:/host/work:rw`],
      identityLocalSourceResolver, state, runnerHome,
    )).not.toThrow();
    expect(spy.mock.calls.some(([candidate]) => String(candidate).startsWith(`${runnerHome}/.`))).toBe(false);
  });
});
