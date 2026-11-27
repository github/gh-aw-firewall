import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import execa from 'execa';
import type { WrapperConfig } from './types';
import { AGENT_CONTAINER_NAME } from './constants';
import { getLocalDockerEnv } from './docker-host';
import { normalizeDockerHostPathPrefix } from './services/host-path-prefix';
import { resolvePathThroughExistingAncestor } from './enclave/mount-policy';

const CONTROL_DIR = '/run/awf-private-host-sockets';
const PRIVATE_FILESYSTEMS = new Set(['ext4', 'xfs', 'tmpfs']);
const INSPECTABLE_FILESYSTEMS = new Set([
  ...PRIVATE_FILESYSTEMS, 'proc', 'sysfs', 'devtmpfs', 'devpts', 'mqueue',
  'cgroup', 'cgroup2', 'securityfs', 'debugfs', 'tracefs', 'configfs',
  'hugetlbfs', 'bpf', 'binfmt_misc', 'ramfs',
  'pstore', 'efivarfs', 'fusectl',
]);
// Reject caller loader/hooks before the first process. The entrypoint's AWF-owned
// one-shot-token preload is trusted startup code and intentionally survives the
// command gate. Like the entrypoint, it must never spoof release or launch user code.
const BOOTSTRAP_ENV = [
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'GCONV_PATH', 'GLIBC_TUNABLES',
  'BASH_ENV', 'ENV', 'NODE_OPTIONS', 'SHELLOPTS', 'BASHOPTS', 'PS4',
];
const BOOTSTRAP_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const BOOTSTRAP_TARGETS = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', CONTROL_DIR];
const ENTRYPOINT_PATH = '/usr/local/bin/entrypoint.sh';
const CHROOT_GATE_VERSION = 'AWF_PRIVATE_HOST_SOCKET_GATE_V1';
const ENTRYPOINT = [
  '/bin/bash', '--noprofile', '--norc', '-p', '-c',
  `for ((n=0; n<1200; n++)); do
  if [ -f ${CONTROL_DIR}/allow-setup ]; then
    unset_args=()
    while IFS= read -r -d '' entry; do
      key=\${entry%%=*}
      case "$key" in BASH_FUNC_*%%) unset_args+=(-u "$key");; esac
    done </proc/self/environ || exit 125
    export ${CHROOT_GATE_VERSION}=1
    exec /usr/bin/env "\${unset_args[@]}" ${ENTRYPOINT_PATH} "$@"
  fi
  /bin/sleep 0.1
done
printf '%s\\n' 'Private host socket isolation was not established; agent not started.' >&2
exit 125`,
  'awf-private-host-sockets',
];
const COMMAND_GATE = [
  '/bin/bash', '--noprofile', '--norc', '-p', '-c',
  `: >${CONTROL_DIR}/probe/ready || exit 125
for ((n=0; n<1200; n++)); do
  if [ -f ${CONTROL_DIR}/allow ]; then exec "$@"; fi
  /bin/sleep 0.1
done
printf '%s\\n' 'Final private host socket isolation was not established; command not started.' >&2
exit 125`,
  'awf-private-host-socket-command',
];
function wrapPrivateHostSocketCommand(command: string[]): string[] {
  return [...COMMAND_GATE, ...command];
}

interface MountIdentity {
  device: string;
  root: string;
  mountPoint: string;
  filesystem: string;
  propagation: string[];
  superOptions: string[];
}

interface PrivateDirectory {
  original: string;
  resolved: string;
  identity: MountIdentity;
  ancestors: string[];
}

function failure(reason: string): Error {
  return new Error(`Private host socket isolation could not be established: ${reason}`);
}

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('../'));
}

function overlaps(left: string, right: string): boolean {
  return contains(left, right) || contains(right, left);
}

function decodeMountPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}

/** Kernel filesystem coordinates also identify bind aliases that realpath cannot resolve. */
export function parseSocketMountInfo(text: string): MountIdentity[] {
  const lines = text.trim().split('\n');
  return lines.map(line => {
    const fields = line.split(' ');
    const separator = fields.indexOf('-');
    if (separator < 6 || fields.length < separator + 4 || !/^\d+:\d+$/.test(fields[2])) {
      throw failure('uninspectable mount table');
    }
    const root = decodeMountPath(fields[3]);
    const mountPoint = decodeMountPath(fields[4]);
    const filesystem = fields[separator + 1];
    // Host Docker namespace handles have roots such as "net:[4026532273]".
    // They are not filesystem paths; coordinate() still refuses to export them.
    if ((!path.isAbsolute(root) && filesystem !== 'nsfs') || !path.isAbsolute(mountPoint)) {
      throw failure('invalid mount path');
    }
    return {
      device: fields[2], root, mountPoint, filesystem,
      propagation: fields.slice(6, separator),
      superOptions: fields[separator + 3].split(','),
    };
  });
}

function coordinate(candidate: string, mounts: MountIdentity[]): MountIdentity {
  if (candidate.split('/').some(component => component === '.' || component === '..')) {
    throw failure('path traversal components are unsupported');
  }
  // existsSync alone would mistake a dangling symlink or an inaccessible path
  // for a missing source. Require realpath on every existing ancestor.
  let ancestor = candidate;
  for (;;) {
    try {
      fs.lstatSync(ancestor);
      fs.realpathSync.native(ancestor);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      // lstat succeeds for a dangling symlink: it must not be treated as absent.
      try {
        if (fs.lstatSync(ancestor).isSymbolicLink()) throw failure('dangling mount-source symlink');
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError;
      }
      ancestor = parent;
    }
  }
  const resolved = resolvePathThroughExistingAncestor(candidate);
  const covering = mounts.filter(mount => contains(mount.mountPoint, resolved))
    .sort((left, right) => right.mountPoint.length - left.mountPoint.length)[0];
  if (covering && mounts.filter(mount => mount.mountPoint === covering.mountPoint).length !== 1) {
    throw failure('ambiguous stacked host mounts');
  }
  if (!covering || !INSPECTABLE_FILESYSTEMS.has(covering.filesystem) || covering.filesystem === 'proc') {
    throw failure('unsupported host filesystem');
  }
  return { ...covering, root: path.join(covering.root, path.relative(covering.mountPoint, resolved)) };
}

function assertDisjoint(roots: PrivateDirectory[], mounts: MountIdentity[]): void {
  for (const mount of mounts) {
    if (roots.some(root => root.identity.device === mount.device && overlaps(root.identity.root, mount.root))) {
      throw failure(`agent-visible mount "${mount.mountPoint}" overlaps a private directory`);
    }
  }
}

function inspectHostSource(source: string, mounts: MountIdentity[]): MountIdentity[] {
  const identity = coordinate(source, mounts);
  const resolved = resolvePathThroughExistingAncestor(source);
  const nested = mounts.filter(mount => contains(resolved, mount.mountPoint));
  if (nested.some(mount => !INSPECTABLE_FILESYSTEMS.has(mount.filesystem) || mount.filesystem === 'proc')) {
    throw failure('unsupported nested host filesystem');
  }
  return [identity, ...nested];
}

function assertAgentMountsIsolated(roots: PrivateDirectory[], mounts: MountIdentity[], rootMount: MountIdentity): void {
  const currentRoots = mounts.filter(mount => mount.mountPoint === '/');
  if (currentRoots.length !== 1 || JSON.stringify(currentRoots[0]) !== JSON.stringify(rootMount)) {
    throw failure('container root mount changed during setup');
  }
  if (mounts.some(mount =>
    mount.propagation.length !== 0
    || (!INSPECTABLE_FILESYSTEMS.has(mount.filesystem)
      && !(mount.filesystem === 'overlay' && rootMount.filesystem === 'overlay' && mount.device === rootMount.device))
  )) throw failure('unsupported or propagating post-setup agent mounts');
  assertDisjoint(roots, mounts);
}

function assertRootOverlayBackingsIsolated(
  roots: PrivateDirectory[], rootMount: MountIdentity, hostMounts: MountIdentity[], storagePaths: string[],
): void {
  if (rootMount.filesystem !== 'overlay') return;
  const storage = storagePaths.map(storagePath => coordinate(storagePath, hostMounts));
  const backings = rootMount.superOptions.flatMap(option => {
    if (option.startsWith('lowerdir=')) return option.slice('lowerdir='.length).split(':');
    if (option.startsWith('upperdir=') || option.startsWith('workdir=')) return [option.slice(option.indexOf('=') + 1)];
    return [];
  });
  if (!rootMount.superOptions.some(option => option.startsWith('lowerdir=')) || backings.length === 0) {
    throw failure('uninspectable container overlay backing paths');
  }
  for (const backing of backings) {
    const resolved = fs.realpathSync.native(decodeMountPath(backing));
    if (!path.isAbsolute(resolved) || !fs.statSync(resolved).isDirectory()) throw failure('invalid overlay backing path');
    const identity = coordinate(resolved, hostMounts);
    if (!storage.some(candidate => identity.device === candidate.device && contains(candidate.root, identity.root))) {
      throw failure('overlay backing outside verified Docker storage');
    }
    assertDisjoint(roots, inspectHostSource(resolved, hostMounts));
  }
}

function dockerStoragePaths(info: { DockerRootDir?: unknown; Driver?: unknown; DriverStatus?: unknown } | null): string[] {
  if (!info || typeof info.DockerRootDir !== 'string' || !path.isAbsolute(info.DockerRootDir)) {
    throw failure('uninspectable Docker storage');
  }
  const paths = [info.DockerRootDir];
  if (info.Driver === 'overlayfs' && Array.isArray(info.DriverStatus)
    && info.DriverStatus.some(entry => Array.isArray(entry)
      && entry[0] === 'driver-type' && entry[1] === 'io.containerd.snapshotter.v1')) {
    paths.push('/var/lib/containerd');
  }
  return paths;
}

function assertDockerSocketDisjoint(config: WrapperConfig, hostMounts: MountIdentity[], agentMounts: MountIdentity[]): void {
  for (const socket of new Set([privateSocketDockerHost(config)!.slice('unix://'.length), '/run/docker.sock', '/var/run/docker.sock'])) {
    if (!fs.existsSync(socket)) continue;
    if (fs.statSync(socket).nlink !== 1) throw failure('hard-linked Docker control socket');
    const identity = coordinate(socket, hostMounts);
    if (agentMounts.some(mount => mount.device === identity.device && overlaps(mount.root, identity.root))) {
      throw failure('an agent mount exposes the Docker control socket');
    }
  }
}

function ancestorIdentities(resolved: string): string[] {
  const identities: string[] = [];
  for (let current = resolved;; current = path.dirname(current)) {
    const stat = fs.statSync(current, { bigint: true });
    identities.push(`${stat.dev}:${stat.ino}`);
    if (current === '/') return identities;
  }
}

function assertSocketLinks(directory: string): void {
  for (const name of fs.readdirSync(directory)) {
    const entry = path.join(directory, name);
    const stat = fs.lstatSync(entry);
    if (stat.isSymbolicLink() || (stat.isSocket() && stat.nlink !== 1)) {
      throw failure('private directories must not contain symlinks or hard-linked sockets');
    }
    if (stat.isDirectory()) assertSocketLinks(entry);
  }
}

function readPrivateDirectories(config: WrapperConfig, mounts: MountIdentity[]): PrivateDirectory[] {
  return (config.privateHostSocketDirs ?? []).map(original => {
    if (typeof original !== 'string' || !path.isAbsolute(original)) throw failure('directories must be absolute');
    if (original.split('/').some(component => component === '.' || component === '..')) {
      throw failure('path traversal components are unsupported');
    }
    const resolved = fs.realpathSync.native(original);
    if (!fs.statSync(resolved).isDirectory()) throw failure('a declared directory does not exist');
    const identity = coordinate(resolved, mounts);
    if (!PRIVATE_FILESYSTEMS.has(identity.filesystem)) throw failure('unsupported private-directory filesystem');
    if (mounts.some(mount => mount.mountPoint !== resolved && contains(resolved, mount.mountPoint))) {
      throw failure('private directories must not contain descendant mounts');
    }
    assertSocketLinks(resolved);
    return { original, resolved, identity, ancestors: ancestorIdentities(resolved) };
  });
}

export function privateSocketDockerHost(config: WrapperConfig): string | undefined {
  if (!config.privateHostSocketDirs?.length) return undefined;
  const dockerEnv = getLocalDockerEnv();
  const host = config.awfDockerHost ?? dockerEnv.DOCKER_HOST ?? 'unix:///var/run/docker.sock';
  if (dockerEnv.DOCKER_CONTEXT || !/^unix:\/\/\/[^/\s][^\s]*$/.test(host)) {
    throw failure('requires an explicit local Linux Docker/runc Unix endpoint without DOCKER_CONTEXT');
  }
  // Explicit DOCKER_HOST takes precedence over a persisted currentContext.
  return host;
}

export function assertPrivateHostSocketRuntime(config: WrapperConfig): void {
  if (!config.privateHostSocketDirs?.length) return;
  privateSocketDockerHost(config);
  if (
    process.platform !== 'linux'
    || process.getuid?.() !== 0
    || (config.containerRuntime !== undefined && config.containerRuntime !== 'runc')
    || config.enableDind || config.runnerTopology === 'arc-dind' || config.legacySecurity
    || config.chrootBinariesSourcePath
    || (config.dockerHostPathPrefix && normalizeDockerHostPathPrefix(config.dockerHostPathPrefix) !== '/')
  ) {
    throw failure('requires privileged host inspection with local Linux Docker/runc without DinD, host-path translation, or legacy security');
  }
  if (config.enableHostAccess) throw failure('host access could expose Docker control endpoints');
  for (const volume of config.volumeMounts ?? []) {
    const [source, target] = volume.split(':');
    if (!source || source.split('/').some(component => component === '.' || component === '..')) {
      throw failure('path traversal components are unsupported');
    }
    if (!target || !path.isAbsolute(target) || target.split('/').some(component => component === '.' || component === '..')) {
      throw failure('unsupported custom mount target');
    }
    const guestTarget = target === '/host' ? '/' : target.startsWith('/host/') ? target.slice('/host'.length) : target;
    if (BOOTSTRAP_TARGETS.some(protectedTarget => overlaps(protectedTarget, guestTarget))) {
      throw failure('custom mounts may not replace trusted bootstrap paths');
    }
  }
}

function assertNestedTargetHasNoSymlink(source: string, parent: string, target: string): void {
  let current = source;
  for (const component of path.relative(parent, target).split(path.sep)) {
    current = path.join(current, component);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw failure(`symlink in composed mount target "${target}"`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

/**
 * Applied to the final Compose service, after optional mounts and path translation.
 * Hold even entrypoint/profile/harness execution until the kernel topology is checked.
 */
export function configurePrivateHostSocketIsolation(config: WrapperConfig, service: {
  volumes: string[];
  tmpfs: string[];
  environment: Record<string, string>;
  entrypoint?: string[];
  runtime?: string;
  healthcheck: { test: string[] };
  command?: string[];
}): void {
  if (!config.privateHostSocketDirs?.length) return;
  assertPrivateHostSocketRuntime(config);
  const mounts = parseSocketMountInfo(fs.readFileSync('/proc/self/mountinfo', 'utf8'));
  const roots = readPrivateDirectories(config, mounts);
  const volumes: Array<{ source: string; target: string }> = [];
  for (const spec of service.volumes) {
    const parts = spec.split(':');
    const [source, target, mode] = parts;
    if (parts.length < 2 || parts.length > 3 || !source || !path.isAbsolute(target)
      || (mode !== undefined && mode !== 'ro' && mode !== 'rw')) {
      throw failure('unsupported mount syntax');
    }
    if (target.split('/').some(component => component === '.' || component === '..')) {
      throw failure('path traversal components are unsupported');
    }
    if (source.split('/').some(component => component === '.' || component === '..')) {
      throw failure('path traversal components are unsupported');
    }
    volumes.push({ source, target: path.normalize(target) });
    // Standalone named volumes are checked using their actual kernel mounts before release.
    if (!path.isAbsolute(source)) continue;
    const visible = inspectHostSource(source, mounts);
    assertDisjoint(roots, visible);
    assertDockerSocketDisjoint(config, mounts, visible);
  }
  for (const target of [...service.volumes.map(spec => spec.split(':')[1]), ...service.tmpfs.map(spec => spec.split(':')[0])]) {
    const resolved = path.normalize(target);
    for (const cover of volumes) {
      if (cover.target !== resolved && contains(cover.target, resolved)) {
        if (!path.isAbsolute(cover.source)) throw failure('uninspectable nested target under a named volume');
        assertNestedTargetHasNoSymlink(cover.source, cover.target, resolved);
      }
    }
  }
  for (const key of BOOTSTRAP_ENV) {
    if (service.environment[key]) throw failure(`unsupported bootstrap environment variable ${key}`);
    // Also override inherited image defaults before the first ELF process starts.
    service.environment[key] = '';
  }
  for (const key of Object.keys(service.environment)) {
    if (/^BASH_FUNC_.*%%$/.test(key)) delete service.environment[key];
  }
  service.environment.PATH = BOOTSTRAP_PATH;
  service.entrypoint = ENTRYPOINT.map(argument => argument.replace(/\$/g, '$$$$'));
  service.command = wrapPrivateHostSocketCommand(service.command ?? ['/bin/bash', '-c', config.agentCommand]);
  service.runtime = 'runc';
  service.healthcheck.test = ['CMD', '/bin/true'];
  const uid = service.environment.AWF_CHROOT_IDENTITY_UID || service.environment.AWF_USER_UID || '1001';
  const gid = service.environment.AWF_CHROOT_IDENTITY_GID || service.environment.AWF_USER_GID || '1001';
  if (!/^[1-9]\d*$/.test(uid) || !/^[1-9]\d*$/.test(gid)) throw failure('unsupported agent identity');
  for (const prefix of ['', '/host']) {
    service.tmpfs.push(
      `${prefix}${CONTROL_DIR}:rw,noexec,nosuid,nodev,size=64k,mode=0711,uid=0,gid=0`,
      `${prefix}${CONTROL_DIR}/probe:rw,noexec,nosuid,nodev,size=64k,mode=0700,uid=${uid},gid=${gid}`,
    );
  }
}

/**
 * Snapshot before startup, then prove the actual running container's complete mount
 * namespace and unchanged private roots before opening its pre-entrypoint gate.
 * No host socket is removed, chmodded, masked, or exported to another service.
 */
export function preparePrivateHostSocketIsolation(config: WrapperConfig): (() => Promise<'setup-exited' | void>) | undefined {
  if (!config.privateHostSocketDirs?.length) return undefined;
  assertPrivateHostSocketRuntime(config);
  const roots = readPrivateDirectories(config, parseSocketMountInfo(fs.readFileSync('/proc/self/mountinfo', 'utf8')));
  return async () => {
    const dockerOptions = {
      env: { ...getLocalDockerEnv(), DOCKER_HOST: privateSocketDockerHost(config) },
      timeout: 10_000, maxBuffer: 1024 * 1024,
    };
    const result = await execa('docker', ['inspect', AGENT_CONTAINER_NAME], dockerOptions);
    const inspected = JSON.parse(result.stdout);
    if (!Array.isArray(inspected) || inspected.length !== 1) throw failure('invalid container inspection');
    const container = inspected[0];
    const hostConfig = container.HostConfig;
    if (
      !/^[a-f0-9]{64}$/.test(container.Id) || !container.State?.Running
      || !Number.isSafeInteger(container.State.Pid) || container.State.Pid <= 0
      || hostConfig?.Runtime !== 'runc' || hostConfig.Privileged
      || hostConfig.PidMode || (hostConfig.IpcMode && hostConfig.IpcMode !== 'private')
      || hostConfig.NetworkMode === 'host' || hostConfig.NetworkMode?.startsWith('container:')
      || hostConfig.VolumesFrom?.length
      || JSON.stringify(container.Config?.Entrypoint) !== JSON.stringify(ENTRYPOINT)
      || !Array.isArray(container.Config?.Cmd) || container.Config.Cmd.length <= COMMAND_GATE.length
      || !COMMAND_GATE.every((argument, index) => container.Config.Cmd[index] === argument)
      || !Array.isArray(container.Config?.Env)
      || BOOTSTRAP_ENV.some(key => container.Config.Env.some((entry: string) =>
        entry.startsWith(`${key}=`) && entry !== `${key}=`))
      || !container.Config.Env.includes(`PATH=${BOOTSTRAP_PATH}`)
      || !Array.isArray(container.Mounts)
      || container.Mounts.some((mount: { Type: string; Driver?: string }) =>
        !['bind', 'volume', 'tmpfs'].includes(mount.Type)
        || (mount.Type === 'volume' && mount.Driver !== 'local'))
    ) throw failure('unsupported actual container topology');

    const hostMounts = parseSocketMountInfo(fs.readFileSync('/proc/self/mountinfo', 'utf8'));
    for (const mount of container.Mounts as Array<{ Type: string; Source?: string }>) {
      if (mount.Type === 'tmpfs') continue;
      if (!mount.Source || !path.isAbsolute(mount.Source)) throw failure('uninspectable actual mount source');
      const visible = inspectHostSource(mount.Source, hostMounts);
      assertDisjoint(roots, visible);
      assertDockerSocketDisjoint(config, hostMounts, visible);
    }
    const assertRootsUnchanged = (): void => {
      const current = readPrivateDirectories(config, parseSocketMountInfo(fs.readFileSync('/proc/self/mountinfo', 'utf8')));
      if (JSON.stringify(current) !== JSON.stringify(roots)) throw failure('private paths changed during startup');
    };
    assertRootsUnchanged();
    const procRoot = `/proc/${container.State.Pid}/root`;
    const chroot = container.Config.Env.includes('AWF_CHROOT_ENABLED=true');
    if (chroot && !fs.readFileSync(path.join(procRoot, ENTRYPOINT_PATH), 'utf8').includes(CHROOT_GATE_VERSION)) {
      throw failure('agent image does not support the pre-PATH chroot gate');
    }
    const agentMounts = parseSocketMountInfo(fs.readFileSync(`/proc/${container.State.Pid}/mountinfo`, 'utf8'));
    const rootMounts = agentMounts.filter(mount => mount.mountPoint === '/');
    if (rootMounts.length !== 1) throw failure('uninspectable container root mount');
    const rootMount = rootMounts[0];
    assertAgentMountsIsolated(roots, agentMounts, rootMount);
    assertDockerSocketDisjoint(config, hostMounts, agentMounts);

    // Docker storage can be an overlay backing directory, an alias not represented
    // by its overlay device number. Private sockets may never live in that storage.
    const info = await execa('docker', ['info', '--format', '{{json .}}'], dockerOptions);
    const storagePaths = dockerStoragePaths(JSON.parse(info.stdout));
    for (const storagePath of storagePaths) assertDisjoint(roots, [coordinate(storagePath, hostMounts)]);
    assertRootOverlayBackingsIsolated(roots, rootMount, hostMounts, storagePaths);

    const control = path.join(procRoot, CONTROL_DIR);
    const gateMounts = agentMounts.filter(mount => mount.mountPoint === CONTROL_DIR);
    const controlStat = fs.statSync(control);
    if (gateMounts.length !== 1 || gateMounts[0].filesystem !== 'tmpfs'
      || !controlStat.isDirectory() || controlStat.uid !== 0 || (controlStat.mode & 0o022) !== 0) {
      throw failure('missing private startup gate');
    }
    // Prove this PID and filesystem belong to the selected daemon, not a remote
    // daemon or another PID namespace. The nonce is not a credential.
    const nonce = randomBytes(32).toString('hex');
    fs.writeFileSync(path.join(control, 'challenge'), nonce, { flag: 'wx', mode: 0o600 });
    const challengePath = CONTROL_DIR + '/challenge';
    const proof = await execa('docker', [
      'exec', '--user', '0:0', container.Id, '/bin/cat', challengePath,
    ], dockerOptions);
    if (proof.stdout !== nonce) throw failure('runner and daemon do not share an inspectable filesystem');
    fs.unlinkSync(path.join(control, 'challenge'));
    fs.writeFileSync(path.join(control, 'allow-setup'), '', { flag: 'wx', mode: 0o400 });
    const commandControl = chroot
      ? path.join(procRoot, '/host', CONTROL_DIR)
      : control;
    const deadline = Date.now() + 120_000;
    let nextStateCheck = Date.now() + 1000;
    while (!fs.existsSync(path.join(commandControl, 'probe', 'ready'))) {
      if (Date.now() >= deadline) throw failure('post-setup command gate was not reached');
      if (Date.now() >= nextStateCheck) {
        const state = await execa('docker', ['inspect', '--format', '{{.State.Status}} {{.State.ExitCode}}', container.Id], dockerOptions);
        if (/^exited [1-9]\d*$/.test(state.stdout)) return 'setup-exited';
        if (!state.stdout.startsWith('running ')) throw failure('entrypoint exited before the command gate');
        nextStateCheck = Date.now() + 1000;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    // The trusted entrypoint has now finished all mount setup and dropped the
    // command's privileges. Recheck its actual namespace, not just Compose binds.
    const finalMounts = parseSocketMountInfo(fs.readFileSync(`/proc/${container.State.Pid}/mountinfo`, 'utf8'));
    assertAgentMountsIsolated(roots, finalMounts, rootMount);
    assertRootOverlayBackingsIsolated(
      roots, rootMount, parseSocketMountInfo(fs.readFileSync('/proc/self/mountinfo', 'utf8')), storagePaths,
    );
    assertDockerSocketDisjoint(config, parseSocketMountInfo(fs.readFileSync('/proc/self/mountinfo', 'utf8')), finalMounts);
    const gateTarget = commandControl === control ? CONTROL_DIR : '/host' + CONTROL_DIR;
    const finalGateMounts = finalMounts.filter(mount => mount.mountPoint === gateTarget);
    const finalControlStat = fs.statSync(commandControl);
    if (finalGateMounts.length !== 1 || finalGateMounts[0].filesystem !== 'tmpfs'
      || finalControlStat.uid !== 0 || (finalControlStat.mode & 0o022) !== 0) throw failure('missing final command gate');
    const state = await execa('docker', [
      'inspect', '--format', '{{.State.Pid}} {{.State.Running}}', container.Id,
    ], dockerOptions);
    if (state.stdout !== `${container.State.Pid} true`) throw failure('container changed during inspection');
    assertRootsUnchanged();
    fs.writeFileSync(path.join(commandControl, 'allow'), '', { flag: 'wx', mode: 0o444 });
  };
}

/** @internal Exported for adversarial mount-table regression tests. */
// ts-prune-ignore-next
export const privateSocketTestHelpers = {
  readPrivateDirectories, assertDisjoint, coordinate, inspectHostSource,
  assertAgentMountsIsolated, assertRootOverlayBackingsIsolated, dockerStoragePaths,
  ENTRYPOINT, COMMAND_GATE, CONTROL_DIR, wrapPrivateHostSocketCommand,
};
