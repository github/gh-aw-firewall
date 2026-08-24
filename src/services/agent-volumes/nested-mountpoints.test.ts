import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ensureNestedMountpoints,
  planNestedMountpoints,
} from './nested-mountpoints';
import { createLocalSourceResolver } from './mount-topology';
import { pruneUnmountableCredentialOverlays } from './credential-hiding';
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

/**
 * Cleanup for the product-owned, *fixed* /tmp paths that a /tmp-rooted
 * `--docker-host-path-prefix` writes to (`/tmp/awf-init`,
 * `/tmp/awf-runner-bin`, `/tmp/awf-docker-host-stage`).
 *
 * Deliberately removes *files only*, and only files this run provably owns:
 * the uniquely named staged binary, the mountpoint that was materialised for
 * it, the per-run random `chroot-*` staging directory, and staged copies that
 * did not exist before the build.
 *
 * It never removes the shared root directories themselves, for two measured
 * reasons:
 *   - Several pre-existing suites create them concurrently under
 *     `maxWorkers`, so deleting one races with a worker that still needs it.
 *   - `ensureNestedMountpoints` chowns any directory it creates, and macOS
 *     denies chown to non-root. So on macOS a *missing* `/tmp/awf-init` makes
 *     unrelated suites fail with EPERM, where a pre-existing one succeeds.
 * Tests must therefore never depend on these roots being absent or present;
 * the assertions below read the planned `hostPath` instead of `existsSync`.
 */
function makeFixedTmpArtifactTracker(stagedCopies: string[] = []) {
  const files: string[] = [];
  const dirs: string[] = [];

  return {
    /** Call before building, so pre-existing copies are never removed. */
    noteBeforeBuild(): void {
      for (const copy of stagedCopies) {
        if (!fs.existsSync(copy)) files.push(copy);
      }
    },
    /** Attribute this run's artefacts from the specs it actually generated. */
    trackGenerated(volumes: string[], binaryName: string): void {
      for (const spec of volumes) {
        const [source = '', target = ''] = spec.split(':');
        const chroot = /^(\/tmp\/awf-docker-host-stage\/chroot-[A-Za-z0-9_-]+)\//.exec(source);
        if (chroot) {
          dirs.push(chroot[1]);
          continue;
        }
        if (!binaryName || path.basename(source) !== binaryName) continue;
        // The staged copy is the bind *source*; the mountpoint that
        // ensureNestedMountpoints had to materialise under the narrowed /tmp
        // cover is the bind *target*. Both are real files on this machine.
        for (const candidate of [source, target]) {
          if (candidate.startsWith('/tmp/')) files.push(candidate);
        }
      }
    },
    cleanup(): void {
      files.splice(0).forEach((file) => {
        try {
          fs.unlinkSync(file);
        } catch {
          // Never created, or already gone.
        }
      });
      // Random per-run name, so a recursive remove here cannot reach anything
      // another worker owns.
      dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
    },
  };
}

// Staged under fixed, stable names rather than per-run ones, so they can only
// be reclaimed when this suite is the run that created them.
const FIXED_TMP_STAGED_COPIES = [
  '/tmp/awf-docker-host-stage/etc/passwd',
  '/tmp/awf-docker-host-stage/etc/group',
  '/tmp/awf-docker-host-stage/identity/passwd',
  '/tmp/awf-docker-host-stage/identity/group',
];

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
      const emptyHome = path.join(tmpRoot, 'chroot-home');
      const logs = path.join(tmpRoot, 'agent-logs');
      [emptyHome, logs].forEach((dir) => fs.mkdirSync(dir, { recursive: true }));
      const volumes = [
        `${emptyHome}:/host/home/runner:ro`,
        `${logs}:/host/home/runner/.copilot/logs:rw`,
      ];

      expect(planNestedMountpoints(volumes)).toEqual([
        expect.objectContaining({
          containerTarget: '/host/home/runner/.copilot/logs',
          coveringTarget: '/host/home/runner',
          coveringSource: emptyHome,
          hostPath: path.join(emptyHome, '.copilot/logs'),
          kind: 'directory',
          credentialOverlay: false,
        }),
      ]);
    });

    it('cannot classify a source that this filesystem cannot see at all', () => {
      const volumes = [
        '/empty-home:/host/home/runner:ro',
        '/daemon-only/logs:/host/home/runner/.copilot/logs:rw',
      ];
      // Under --docker-host-path-prefix a source can belong to the daemon's
      // filesystem, not the runner's. There is nothing here to stat, so the kind
      // is reported as unknown rather than assumed. A source that is merely
      // absent is different: the daemon materialises those as directories, and
      // `resolveSourceKind` classifies them accordingly.
      const resolver = (source: string): string | undefined =>
        source.startsWith('/daemon-only/') ? undefined : source;

      expect(planNestedMountpoints(volumes, resolver)[0]).toEqual(
        expect.objectContaining({ kind: 'unknown', credentialOverlay: false }),
      );
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

      // The real pipeline prunes unmountable overlays first, which is what makes
      // the mask safe to drop: the path is unreachable behind a read-only bind,
      // so nothing is left unmasked.
      const pruned = pruneUnmountableCredentialOverlays(volumes);
      expect(pruned).not.toContain('/dev/null:/host/home/runner/.netrc:ro');
      expect(ensureNestedMountpoints(pruned, uid, gid)).toEqual([]);
      expect(fs.existsSync(path.join(emptyHome, '.netrc'))).toBe(false);
    });

    it('refuses to launch rather than create a credential mountpoint itself', () => {
      const { emptyHome } = makeTree();
      // Same list, but without the prune step: AWF must not quietly paper over
      // an overlay it cannot satisfy, and it must not create the credential path.
      const volumes = [
        `${emptyHome}:/host/home/runner:ro`,
        '/dev/null:/host/home/runner/.netrc:ro',
      ];

      expect(() => ensureNestedMountpoints(volumes, uid, gid)).toThrow(/must not create/);
      expect(fs.existsSync(path.join(emptyHome, '.netrc'))).toBe(false);
    });

    it('creates a directory for a source the daemon has not materialised yet', () => {
      const { emptyHome } = makeTree();
      // AWF creates the init signal directory after the volume list is built,
      // so at this point the source legitimately does not exist. This is the
      // real shape of the agent's legacy `/tmp/awf-init` bind under a narrowed
      // `/tmp`, and it must not be mistaken for an unclassifiable source.
      const notYetCreated = path.join(tmpRoot, 'init-signal');
      const volumes = [
        `${emptyHome}:/host/home/runner:ro`,
        `${notYetCreated}:/host/home/runner/.copilot/logs:rw`,
      ];

      expect(() => ensureNestedMountpoints(volumes, uid, gid)).not.toThrow();
      const mountpoint = path.join(emptyHome, '.copilot/logs');
      expect(fs.statSync(mountpoint).isDirectory()).toBe(true);
    });

    it('fails closed on a required mountpoint whose source cannot be classified', () => {
      const { emptyHome } = makeTree();
      const volumes = [
        `${emptyHome}:/host/home/runner:ro`,
        `/daemon-only/opaque:/host/home/runner/.copilot/logs:rw`,
      ];
      // A daemon-side source we never staged: there is nothing on this
      // filesystem to inspect. Guessing could create the wrong node type, and
      // skipping it silently is what produced the opaque EROFS this pass exists
      // to prevent.
      const resolver = (source: string): string | undefined =>
        source.startsWith('/daemon-only/') ? undefined : source;

      expect(() => ensureNestedMountpoints(volumes, uid, gid, resolver))
        .toThrow(/could not be classified/);
      expect(fs.existsSync(path.join(emptyHome, '.copilot'))).toBe(false);
    });

    it('creates a file mountpoint for a regular-file bind under a read-only cover', () => {
      const { emptyHome } = makeTree();
      const sourceFile = path.join(tmpRoot, 'runner-binary');
      fs.writeFileSync(sourceFile, '#!/bin/sh\n', { mode: 0o755 });
      const volumes = [
        `${emptyHome}:/host/home/runner:ro`,
        `${sourceFile}:/host/home/runner/bin/tool:ro`,
      ];

      const created = ensureNestedMountpoints(volumes, uid, gid);

      const mountpoint = path.join(emptyHome, 'bin/tool');
      expect(created).toEqual([mountpoint]);
      // A single stat answers both questions: an empty regular file. The
      // placeholder is never written to, so its size is the assertion.
      const placeholder = fs.statSync(mountpoint);
      expect(placeholder.isFile()).toBe(true);
      expect(placeholder.size).toBe(0);
      // Owner-only: these paths can land in a world-writable directory, and a
      // bind does not need its mountpoint to be readable by anyone else.
      expect(placeholder.mode & 0o077).toBe(0);
      // The parent directory has to be created too, or the file cannot land.
      expect(fs.statSync(path.join(emptyHome, 'bin')).isDirectory()).toBe(true);
    });

    it('refuses a symlink planted where a file mountpoint belongs', () => {
      const { emptyHome } = makeTree();
      const sourceFile = path.join(tmpRoot, 'runner-binary');
      fs.writeFileSync(sourceFile, '#!/bin/sh\n', { mode: 0o755 });
      fs.mkdirSync(path.join(emptyHome, 'bin'), { recursive: true });
      // A dangling symlink needs no race to plant: existsSync() follows it and
      // reports false, so preparation proceeds, and an exclusive create then
      // fails with EEXIST. Returning quietly there would hand runc an
      // attacker-chosen mountpoint in a world-writable directory.
      fs.symlinkSync('/nonexistent-target', path.join(emptyHome, 'bin/tool'));
      const volumes = [
        `${emptyHome}:/host/home/runner:ro`,
        `${sourceFile}:/host/home/runner/bin/tool:ro`,
      ];

      expect(() => ensureNestedMountpoints(volumes, uid, gid)).toThrow(/symlink/i);
      // The plant is reported, never followed and never replaced.
      expect(fs.lstatSync(path.join(emptyHome, 'bin/tool')).isSymbolicLink()).toBe(true);
    });

    it('refuses a directory planted where a file mountpoint belongs', () => {
      const { emptyHome } = makeTree();
      const sourceFile = path.join(tmpRoot, 'runner-binary');
      fs.writeFileSync(sourceFile, '#!/bin/sh\n', { mode: 0o755 });
      fs.mkdirSync(path.join(emptyHome, 'bin/tool'), { recursive: true });
      const volumes = [
        `${emptyHome}:/host/home/runner:ro`,
        `${sourceFile}:/host/home/runner/bin/tool:ro`,
      ];

      // A directory standing in for a file is not a usable mountpoint: the
      // daemon rejects the bind with "not a directory" once the run is under
      // way, which is far later and far more opaque than failing here.
      expect(() => ensureNestedMountpoints(volumes, uid, gid)).toThrow(/not a regular file/i);
    });

    it('leaves an existing file mountpoint untouched', () => {
      const { emptyHome } = makeTree();
      const sourceFile = path.join(tmpRoot, 'runner-binary');
      fs.writeFileSync(sourceFile, '#!/bin/sh\n', { mode: 0o755 });
      fs.mkdirSync(path.join(emptyHome, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(emptyHome, 'bin/tool'), 'PRE-EXISTING');
      const volumes = [
        `${emptyHome}:/host/home/runner:ro`,
        `${sourceFile}:/host/home/runner/bin/tool:ro`,
      ];

      expect(ensureNestedMountpoints(volumes, uid, gid)).toEqual([]);
      expect(fs.readFileSync(path.join(emptyHome, 'bin/tool'), 'utf8')).toBe('PRE-EXISTING');
    });

    it('skips daemon-side covers instead of creating a runner-local tree', () => {
      const { logs } = makeTree();
      // A *daemon-only* prefix. This deliberately does not use the suite's own
      // tmpRoot: under `TMPDIR=/tmp` that is a shared prefix, which is runner
      // resolvable by design, so the test would assert the opposite of its name
      // on Linux while still passing on macOS (where realpath yields
      // /private/var/...).
      const daemonHome = '/daemon-only/home/runner';
      const resolver = createLocalSourceResolver(new Map(), '/daemon-only');
      const volumes = [
        `${daemonHome}:/host/home/runner:ro`,
        `${logs}:/host/home/runner/.copilot/logs:rw`,
      ];

      expect(ensureNestedMountpoints(volumes, uid, gid, resolver)).toEqual([]);
      // The cover was left alone rather than fabricated on this filesystem.
      expect(fs.existsSync('/daemon-only')).toBe(false);
    });
  });

  describe('buildAgentVolumes (end-to-end topology)', () => {
    // Narrowing /tmp makes the legacy init bind materialise the shared
    // /tmp/awf-init mountpoint. That root is intentionally left in place; see
    // makeFixedTmpArtifactTracker for why removing it is unsafe.
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

  // A regular-file bind nested inside a read-only cover needs a *file*
  // mountpoint. runc cannot create one inside a read-only bind any more than it
  // can create a directory, so this has to be prepared too. It is reachable on
  // split-filesystem runners: the agent binary is staged under the daemon path
  // prefix and published at /tmp/awf-runner-bin/<name>, while a write policy
  // narrows the /tmp:/tmp bind to read-only.
  describe('buildAgentVolumes (staged runner binary under --docker-host-path-prefix)', () => {
    const prefixRoots: string[] = [];
    const runnerBinPaths: string[] = [];
    // This case narrows /tmp too, so it also materialises the fixed
    // /tmp/awf-init and /tmp/awf-runner-bin mountpoints.
    const fixedTmp = makeFixedTmpArtifactTracker(FIXED_TMP_STAGED_COPIES);

    afterEach(() => {
      // Staging and the /tmp cover are both real paths by construction: the
      // staging root has to sit under the daemon prefix, and the cover bind is
      // hardcoded to /tmp.
      prefixRoots.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
      runnerBinPaths.splice(0).forEach((file) => fs.rmSync(file, { force: true }));
      fixedTmp.cleanup();
    });

    function stageSplitFsLayout() {
      const unique = path.basename(tmpRoot).replace(/[^a-zA-Z0-9]/g, '');
      const binaryName = `awfprobe${unique}`;
      // shouldUseDockerHostStaging only engages for a prefix under /tmp, so this
      // cannot be redirected into the test's own sandbox.
      const dockerHostPathPrefix = `/tmp/awf-prefix-${unique}`;
      prefixRoots.push(dockerHostPathPrefix);
      runnerBinPaths.push(path.join('/tmp/awf-runner-bin', binaryName));

      const home = path.join(tmpRoot, 'home', 'runner');
      const workspaceDir = path.join(home, 'work', 'repo', 'repo');
      const workDir = path.join(tmpRoot, 'awf-run');
      const emptyHome = `${workDir}-chroot-home`;
      const agentLogsPath = path.join(workDir, 'agent-logs');
      const sessionStatePath = path.join(workDir, 'agent-session-state');
      const initSignalDir = path.join(workDir, 'init-signal');
      const binDir = path.join(tmpRoot, 'runner-bin');

      [workspaceDir, workDir, emptyHome, agentLogsPath, sessionStatePath, initSignalDir, binDir]
        .forEach((dir) => fs.mkdirSync(dir, { recursive: true }));
      for (const toolPath of HOME_TOOL_PATHS) {
        fs.mkdirSync(path.join(home, toolPath), { recursive: true });
        fs.mkdirSync(path.join(emptyHome, toolPath), { recursive: true });
      }
      fs.mkdirSync(path.join(emptyHome, 'work', 'repo', 'repo'), { recursive: true });

      const binarySourcePath = path.join(binDir, binaryName);
      fs.writeFileSync(binarySourcePath, '#!/bin/sh\n', { mode: 0o755 });

      fixedTmp.noteBeforeBuild();

      const config = {
        agentCommand: binarySourcePath,
        allowedDomains: [],
        workDir,
        volumeMounts: [],
        dockerHostPathPrefix,
      } as unknown as WrapperConfig;

      return {
        binaryName,
        workspaceDir,
        build: (filesystemAllowWrite?: string[]) => {
          const volumes = buildAgentVolumes({
            config: { ...config, filesystemAllowWrite } as WrapperConfig,
            projectRoot: process.cwd(),
            effectiveHome: home,
            workspaceDir,
            agentLogsPath,
            sessionStatePath,
            initSignalDir,
          });
          fixedTmp.trackGenerated(volumes, binaryName);
          return volumes;
        },
      };
    }

    it('classifies the staged binary mountpoint as a file, not a directory', () => {
      const layout = stageSplitFsLayout();
      const writable = path.join(layout.workspaceDir, 'allowed');
      fs.mkdirSync(writable, { recursive: true });

      const volumes = layout.build([writable]);
      const requirement = planNestedMountpoints(volumes)
        .find((candidate) => candidate.containerTarget.endsWith(`/awf-runner-bin/${layout.binaryName}`));

      expect(requirement).toBeDefined();
      expect(requirement?.kind).toBe('file');
    });

    it('creates the file mountpoint runc cannot create under a read-only /tmp', () => {
      const layout = stageSplitFsLayout();
      const writable = path.join(layout.workspaceDir, 'allowed');
      fs.mkdirSync(writable, { recursive: true });

      const volumes = layout.build([writable]);

      const mountpoint = path.join('/tmp/awf-runner-bin', layout.binaryName);
      // An empty placeholder: it exists only so runc has something to bind over.
      const placeholder = fs.statSync(mountpoint);
      expect(placeholder.isFile()).toBe(true);
      expect(placeholder.size).toBe(0);
      // The bind really is published, and the /tmp cover really is read-only —
      // otherwise this test would pass without exercising anything.
      expect(volumes.some((spec) => spec.endsWith(':/tmp:ro'))).toBe(true);
      expect(volumes.some((spec) => spec.endsWith(`:/tmp/awf-runner-bin/${layout.binaryName}:ro`)))
        .toBe(true);
    });
  });

  // A `--docker-host-path-prefix` of exactly /tmp is *shared*: the runner and
  // the daemon see the same paths there, which is why prefix translation leaves
  // an already-/tmp source unrewritten. The run's own workDir then sits *inside*
  // the prefix, so topology passes still have to resolve it locally. (A /tmp
  // *descendant* such as /tmp/gh-aw is daemon-only and must keep failing
  // closed — covered in mount-topology.test.ts.)
  describe('buildAgentVolumes (--docker-host-path-prefix shares /tmp with the runner)', () => {
    const sharedRoots: string[] = [];
    const fixedTmp = makeFixedTmpArtifactTracker(FIXED_TMP_STAGED_COPIES);

    afterEach(() => {
      sharedRoots.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
      fixedTmp.cleanup();
    });

    function stageSharedTmpLayout() {
      // The prefix under test is the literal /tmp, and the whole run has to sit
      // beneath it, so this cannot be redirected into the suite's sandbox (on
      // macOS os.tmpdir() is /private/var/... and would not nest). mkdtemp
      // rather than a predictable name, so nothing here can be pre-created or
      // redirected by another user on a shared machine.
      const sharedRoot = fs.mkdtempSync('/tmp/awf-shared-');
      sharedRoots.push(sharedRoot);
      const unique = path.basename(sharedRoot).replace(/[^a-zA-Z0-9]/g, '');

      const home = path.join(sharedRoot, 'home', 'runner');
      const workspaceDir = path.join(home, 'work', 'repo', 'repo');
      const workDir = path.join(sharedRoot, 'awf-run');
      const emptyHome = `${workDir}-chroot-home`;
      const agentLogsPath = path.join(workDir, 'agent-logs');
      const sessionStatePath = path.join(workDir, 'agent-session-state');
      const initSignalDir = path.join(workDir, 'init-signal');
      const binDir = path.join(sharedRoot, 'runner-bin');

      [workspaceDir, workDir, emptyHome, agentLogsPath, sessionStatePath, initSignalDir, binDir]
        .forEach((dir) => fs.mkdirSync(dir, { recursive: true }));
      for (const toolPath of HOME_TOOL_PATHS) {
        fs.mkdirSync(path.join(home, toolPath), { recursive: true });
        fs.mkdirSync(path.join(emptyHome, toolPath), { recursive: true });
      }
      fs.mkdirSync(path.join(emptyHome, 'work', 'repo', 'repo'), { recursive: true });

      // A /tmp-rooted prefix also turns on ARC/DinD binary staging, which
      // publishes to fixed paths named after the command. A unique name keeps
      // this run's artefacts distinguishable from a concurrent suite's, and
      // means they can never be mistaken for pre-existing ones.
      const binaryName = `awfshared${unique}`;
      const binarySourcePath = path.join(binDir, binaryName);
      fs.writeFileSync(binarySourcePath, '#!/bin/sh\n', { mode: 0o755 });

      fixedTmp.noteBeforeBuild();

      const config = {
        agentCommand: binarySourcePath,
        allowedDomains: [],
        workDir,
        volumeMounts: [],
        dockerHostPathPrefix: '/tmp',
      } as unknown as WrapperConfig;

      return {
        workspaceDir,
        initSignalDir,
        build: (filesystemAllowWrite?: string[]) => {
          const volumes = buildAgentVolumes({
            config: { ...config, filesystemAllowWrite } as WrapperConfig,
            projectRoot: process.cwd(),
            effectiveHome: home,
            workspaceDir,
            agentLogsPath,
            sessionStatePath,
            initSignalDir,
          });
          fixedTmp.trackGenerated(volumes, binaryName);
          return volumes;
        },
      };
    }

    function stageWritable(layout: ReturnType<typeof stageSharedTmpLayout>): string {
      const writable = path.join(layout.workspaceDir, 'allowed');
      fs.mkdirSync(writable, { recursive: true });
      return writable;
    }

    /**
     * Plans against the resolver the production pipeline actually builds for
     * this config. `planNestedMountpoints` defaults to an identity resolver,
     * which would resolve every source regardless of prefix handling and so
     * could not detect a regression in `createLocalSourceResolver` at all.
     */
    function planWithProductionResolver(volumes: string[]) {
      return planNestedMountpoints(volumes, createLocalSourceResolver(new Map(), '/tmp'));
    }

    it('resolves a workDir nested inside the prefix instead of failing closed', () => {
      const layout = stageSharedTmpLayout();
      const writable = stageWritable(layout);

      expect(() => layout.build([writable])).not.toThrow();
    });

    it('classifies the legacy init signal mountpoint nested under a narrowed /tmp', () => {
      const layout = stageSharedTmpLayout();
      const volumes = layout.build([stageWritable(layout)]);

      const legacy = planWithProductionResolver(volumes)
        .find((requirement) => requirement.containerTarget === '/tmp/awf-init');

      // The source is the run's own init-signal directory, which the CLI just
      // created locally — being under the shared prefix must not make it
      // unclassifiable. Asserted on the plan rather than on disk: a
      // /tmp/awf-init left behind by another suite would otherwise satisfy an
      // existsSync check without this code path ever running.
      expect(legacy?.source).toBe(layout.initSignalDir);
      expect(legacy?.kind).toBe('directory');
      expect(legacy?.hostPath).toBe('/tmp/awf-init');
    });

    it('prepares the nested home mountpoints when the chroot home is under the prefix', () => {
      const layout = stageSharedTmpLayout();
      const volumes = layout.build([stageWritable(layout)]);

      const nestedHomeMounts = planWithProductionResolver(volumes)
        .filter((requirement) => requirement.containerTarget.includes('/.copilot/'));

      // Guards against passing vacuously: the policy really does narrow a home
      // bind that covers these, so there is something to prepare.
      expect(nestedHomeMounts.length).toBeGreaterThan(0);
      for (const requirement of nestedHomeMounts) {
        // An unresolvable covering source leaves hostPath undefined, which
        // silently skips preparation and restores the EROFS failure.
        expect(requirement.hostPath).toBeDefined();
        expect(fs.existsSync(requirement.hostPath as string)).toBe(true);
      }
    });

    it('leaves no unsatisfiable mountpoint for runc', () => {
      const layout = stageSharedTmpLayout();
      const volumes = layout.build([stageWritable(layout)]);
      const requirements = planWithProductionResolver(volumes);

      // Only the mounts landing inside the guest's /tmp are asserted here.
      // ensureNestedMountpoints runs on the topology *before* the prefix is
      // applied, so re-planning the returned list is only faithful where the
      // prefix changes nothing -- which is exactly the already-/tmp-rooted
      // paths this case is about. Anything else is rewritten: on a GitHub
      // runner /opt/hostedtoolcache becomes the daemon-only
      // /tmp/opt/hostedtoolcache, which no runner-local check can resolve.
      const guestTmpMounts = requirements.filter((requirement) =>
        requirement.containerTarget.startsWith('/tmp/'));

      expect(guestTmpMounts.length).toBeGreaterThan(0);
      for (const requirement of guestTmpMounts) {
        expect(requirement.kind).not.toBe('unknown');
        expect(requirement.hostPath).toBeDefined();
        expect(fs.existsSync(requirement.hostPath as string)).toBe(true);
      }
    });
  });
});
