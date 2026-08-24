import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ensureNestedMountpoints,
  planNestedMountpoints,
} from './nested-mountpoints';
import { createLocalSourceResolver } from './mount-topology';
import { HOME_TOOL_PATHS } from '../../config/mount-policy';
import { buildAgentVolumes } from './volume-builder';
import { WrapperConfig } from '../../types';

jest.mock('../../host-env', () => ({
  ...jest.requireActual('../../host-env'),
  // Real runs are root under sudo; the test process is not, so keep chown a no-op
  // by targeting the identity the test already owns.
  getSafeHostUid: () => String(process.getuid?.() ?? 0),
  getSafeHostGid: () => String(process.getgid?.() ?? 0),
}));

/**
 * Models how runc materialises a compose bind list: parents first, and every
 * mountpoint has to already exist inside whichever bind currently covers it.
 * Returns the mounts runc would fail on.
 */
function simulateRuncMountFailures(volumes: string[]): string[] {
  const parsed = volumes
    .map((spec) => {
      const [source, target, mode] = spec.split(':');
      return { spec, source, target, mode: mode || 'rw' };
    })
    .filter((mount) => Boolean(mount.source && mount.target));

  const ordered = [...parsed].sort(
    (a, b) => a.target.split('/').length - b.target.split('/').length,
  );

  const failures: string[] = [];
  const established: typeof ordered = [];

  for (const mount of ordered) {
    const cover = established
      .filter((candidate) => mount.target.startsWith(`${candidate.target}/`))
      .sort((a, b) => b.target.length - a.target.length)[0];

    if (cover) {
      const hostPath = `${cover.source}${mount.target.slice(cover.target.length)}`;
      // runc creates a missing mountpoint with mkdirat; that fails on a
      // read-only cover.
      if (!fs.existsSync(hostPath) && cover.mode === 'ro') failures.push(mount.spec);
    }

    established.push(mount);
  }

  return failures;
}

describe('nested mountpoint preparation', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awf-nested-')));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe('planNestedMountpoints', () => {
    it('reports nothing when every covering bind is writable', () => {
      const volumes = [
        '/host/home/runner:/host/home/runner:rw',
        '/logs:/host/home/runner/.copilot/logs:rw',
      ];

      expect(planNestedMountpoints(volumes)).toEqual([]);
    });

    it('reports the mountpoint a read-only cover cannot create', () => {
      const volumes = [
        '/empty-home:/host/home/runner:ro',
        '/logs:/host/home/runner/.copilot/logs:rw',
      ];

      expect(planNestedMountpoints(volumes)).toEqual([
        expect.objectContaining({
          containerTarget: '/host/home/runner/.copilot/logs',
          coveringTarget: '/host/home/runner',
          coveringSource: '/empty-home',
          hostPath: '/empty-home/.copilot/logs',
          kind: 'directory',
        }),
      ]);
    });

    it('attributes the mountpoint to the innermost cover, not the outermost', () => {
      const volumes = [
        '/empty-home:/host/home/runner:ro',
        '/real-copilot:/host/home/runner/.copilot:ro',
        '/logs:/host/home/runner/.copilot/logs:rw',
      ];

      const requirement = planNestedMountpoints(volumes).find(
        (candidate) => candidate.containerTarget === '/host/home/runner/.copilot/logs',
      );

      expect(requirement?.hostPath).toBe('/real-copilot/logs');
    });

    it('classifies /dev/null credential overlays as files, not directories', () => {
      const volumes = [
        '/empty-home:/host/home/runner:ro',
        '/dev/null:/host/home/runner/.netrc:ro',
      ];

      expect(planNestedMountpoints(volumes)).toEqual([
        expect.objectContaining({ containerTarget: '/host/home/runner/.netrc', kind: 'file' }),
      ]);
    });

    it('reports no host path when the cover is a daemon-side custom mount', () => {
      const resolver = createLocalSourceResolver(new Map(), '/daemon');
      const volumes = [
        '/daemon/mnt:/host/home/runner:ro',
        '/logs:/host/home/runner/.copilot/logs:rw',
      ];

      expect(planNestedMountpoints(volumes, resolver)[0].hostPath).toBeUndefined();
    });

    // GitHub-hosted runners bind `/opt` read-only and nest the tool cache
    // inside it, so a requirement exists even with no write policy. It is
    // already satisfied — source and mountpoint are the same host path — which
    // is why this has always worked and must keep costing nothing.
    it('reports already-satisfied system binds without asking for preparation', () => {
      const volumes = [
        '/opt:/host/opt:ro',
        '/opt/hostedtoolcache:/host/opt/hostedtoolcache:rw',
      ];

      const [requirement] = planNestedMountpoints(volumes);
      expect(requirement.containerTarget).toBe('/host/opt/hostedtoolcache');
      // The mountpoint resolves to the mount's own source, so it exists exactly
      // when the mount does and never needs preparing.
      expect(requirement.hostPath).toBe(requirement.source);
    });
  });

  describe('ensureNestedMountpoints', () => {
    const uid = process.getuid?.() ?? 0;
    const gid = process.getgid?.() ?? 0;

    function makeTree() {
      const emptyHome = path.join(tmpRoot, 'chroot-home');
      const logs = path.join(tmpRoot, 'agent-logs');
      const sessionState = path.join(tmpRoot, 'agent-session-state');
      [emptyHome, logs, sessionState].forEach((dir) => fs.mkdirSync(dir, { recursive: true }));
      return { emptyHome, logs, sessionState };
    }

    it('creates the nested .copilot mountpoints runc could not create itself', () => {
      const { emptyHome, logs, sessionState } = makeTree();
      const volumes = [
        `${emptyHome}:/host/home/runner:ro`,
        `${logs}:/host/home/runner/.copilot/logs:rw`,
        `${sessionState}:/host/home/runner/.copilot/session-state:rw`,
      ];

      expect(simulateRuncMountFailures(volumes)).toHaveLength(2);

      const created = ensureNestedMountpoints(volumes, uid, gid);

      expect(created).toEqual([
        path.join(emptyHome, '.copilot/logs'),
        path.join(emptyHome, '.copilot/session-state'),
      ]);
      expect(simulateRuncMountFailures(volumes)).toEqual([]);
    });

    it('prepares mountpoints inside a real ~/.copilot cover as well as an empty home', () => {
      const { logs } = makeTree();
      const realCopilot = path.join(tmpRoot, 'home', '.copilot');
      fs.mkdirSync(realCopilot, { recursive: true });

      const volumes = [
        `${path.join(tmpRoot, 'home')}:/host/home/runner:ro`,
        `${realCopilot}:/host/home/runner/.copilot:ro`,
        `${logs}:/host/home/runner/.copilot/logs:rw`,
      ];

      ensureNestedMountpoints(volumes, uid, gid);

      expect(fs.existsSync(path.join(realCopilot, 'logs'))).toBe(true);
      expect(simulateRuncMountFailures(volumes)).toEqual([]);
    });

    it('creates nothing when no write policy narrowed a cover to read-only', () => {
      const { emptyHome, logs } = makeTree();
      const volumes = [
        `${emptyHome}:/host/home/runner:rw`,
        `${logs}:/host/home/runner/.copilot/logs:rw`,
      ];

      expect(ensureNestedMountpoints(volumes, uid, gid)).toEqual([]);
      expect(fs.existsSync(path.join(emptyHome, '.copilot'))).toBe(false);
    });

    it('never fabricates a credential file for a /dev/null overlay', () => {
      const { emptyHome } = makeTree();
      const volumes = [
        `${emptyHome}:/host/home/runner:ro`,
        '/dev/null:/host/home/runner/.netrc:ro',
      ];

      expect(ensureNestedMountpoints(volumes, uid, gid)).toEqual([]);
      expect(fs.existsSync(path.join(emptyHome, '.netrc'))).toBe(false);
    });

    it('skips mounts whose source does not exist on this filesystem', () => {
      const { emptyHome } = makeTree();
      const volumes = [
        `${emptyHome}:/host/home/runner:ro`,
        `${path.join(tmpRoot, 'missing-source')}:/host/home/runner/.copilot/logs:rw`,
      ];

      expect(ensureNestedMountpoints(volumes, uid, gid)).toEqual([]);
    });

    it('skips daemon-side covers instead of creating a runner-local tree', () => {
      const { emptyHome, logs } = makeTree();
      const resolver = createLocalSourceResolver(new Map(), tmpRoot);
      const volumes = [
        `${emptyHome}:/host/home/runner:ro`,
        `${logs}:/host/home/runner/.copilot/logs:rw`,
      ];

      expect(ensureNestedMountpoints(volumes, uid, gid, resolver)).toEqual([]);
      expect(fs.existsSync(path.join(emptyHome, '.copilot'))).toBe(false);
    });
  });

  describe('buildAgentVolumes (end-to-end topology)', () => {
    function stageRunnerLayout() {
      const home = path.join(tmpRoot, 'home', 'runner');
      const workspaceDir = path.join(home, 'work', 'repo', 'repo');
      const workDir = path.join(tmpRoot, 'awf-run');
      const emptyHome = `${workDir}-chroot-home`;
      const agentLogsPath = path.join(workDir, 'agent-logs');
      const sessionStatePath = path.join(workDir, 'agent-session-state');
      const initSignalDir = path.join(workDir, 'init-signal');

      [workspaceDir, workDir, emptyHome, agentLogsPath, sessionStatePath, initSignalDir]
        .forEach((dir) => fs.mkdirSync(dir, { recursive: true }));
      // Mirror prepareChrootHomeMounts: host tool dirs plus their chroot placeholders.
      for (const toolPath of HOME_TOOL_PATHS) {
        fs.mkdirSync(path.join(home, toolPath), { recursive: true });
        fs.mkdirSync(path.join(emptyHome, toolPath), { recursive: true });
      }
      fs.mkdirSync(path.join(emptyHome, 'work', 'repo', 'repo'), { recursive: true });

      const config = {
        agentCommand: 'true',
        allowedDomains: [],
        workDir,
        volumeMounts: [],
      } as unknown as WrapperConfig;

      return {
        home,
        workspaceDir,
        emptyHome,
        build: (filesystemAllowWrite?: string[]) => buildAgentVolumes({
          config: { ...config, filesystemAllowWrite } as WrapperConfig,
          projectRoot: process.cwd(),
          effectiveHome: home,
          workspaceDir,
          agentLogsPath,
          sessionStatePath,
          initSignalDir,
        }),
      };
    }

    it('leaves every nested mountpoint satisfiable when a write policy narrows the home tree', () => {
      const layout = stageRunnerLayout();
      const writable = path.join(layout.workspaceDir, 'allowed');
      fs.mkdirSync(writable, { recursive: true });

      const volumes = layout.build([writable]);

      expect(volumes.some((spec) => spec.includes('/.copilot/logs:rw'))).toBe(true);
      expect(simulateRuncMountFailures(volumes)).toEqual([]);
    });

    it('creates the .copilot log and session-state mountpoints runc cannot', () => {
      const layout = stageRunnerLayout();
      const writable = path.join(layout.workspaceDir, 'allowed');
      fs.mkdirSync(writable, { recursive: true });

      layout.build([writable]);

      // The real ~/.copilot bind is the innermost cover for both nested mounts.
      expect(fs.existsSync(path.join(layout.home, '.copilot/logs'))).toBe(true);
      expect(fs.existsSync(path.join(layout.home, '.copilot/session-state'))).toBe(true);
    });

    it('changes nothing on disk and needs no preparation without a policy', () => {
      const layout = stageRunnerLayout();

      const volumes = layout.build(undefined);

      // `ensureNestedMountpoints` only ever creates a requirement's `hostPath`,
      // and that is always `coveringSource` + suffix. No requirement is covered
      // by an AWF-owned bind, so nothing in the staged tree can have been
      // created...
      const staged = planNestedMountpoints(volumes)
        .filter((requirement) => requirement.coveringSource.startsWith(tmpRoot));
      expect(staged).toEqual([]);
      expect(fs.existsSync(path.join(layout.home, '.copilot/logs'))).toBe(false);
      expect(fs.existsSync(path.join(layout.home, '.copilot/session-state'))).toBe(false);
      // ...and every remaining requirement is a system bind AWF has always
      // emitted (on a GitHub-hosted runner `/opt` covers `/opt/hostedtoolcache`)
      // whose mountpoint already exists, so nothing was created there either.
      expect(simulateRuncMountFailures(volumes)).toEqual([]);
    });
  });
});
