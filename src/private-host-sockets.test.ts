import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import execa from 'execa';
import {
  assertPrivateHostSocketRuntime, configurePrivateHostSocketIsolation,
  parseSocketMountInfo, preparePrivateHostSocketIsolation, privateSocketTestHelpers,
} from './private-host-sockets';
import { setAwfDockerHost } from './docker-host';
import type { WrapperConfig } from './types';

jest.mock('execa', () => jest.fn());
const docker = execa as jest.MockedFunction<typeof execa>;
const realReadFileSync = fs.readFileSync;
const {
  readPrivateDirectories, assertDisjoint, coordinate, ENTRYPOINT, CONTROL_DIR,
  wrapPrivateHostSocketCommand, assertAgentMountsIsolated, assertRootOverlayBackingsIsolated, inspectHostSource,
  dockerStoragePaths,
} = privateSocketTestHelpers;

const linuxTests = process.platform === 'linux' ? describe : describe.skip;

linuxTests('trusted host socket isolation', () => {
  let directory: string;
  let privateDir: string;
  let visibleDir: string;
  let config: WrapperConfig;
  const hostMountInfo = [
    '1 0 8:1 / / rw - ext4 /dev/root rw',
    '2 1 0:2 / /proc rw - proc proc rw',
  ].join('\n');

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-private-sockets-'));
    privateDir = path.join(directory, 'private');
    visibleDir = path.join(directory, 'visible');
    fs.mkdirSync(privateDir);
    fs.mkdirSync(visibleDir);
    config = {
      workDir: path.join(directory, 'work'), allowedDomains: [], agentCommand: 'true',
      logLevel: 'error', keepContainers: false, privateHostSocketDirs: [privateDir],
    };
    jest.spyOn(process, 'getuid').mockReturnValue(0);
    const readFileSync = fs.readFileSync;
    jest.spyOn(jest.requireActual<typeof fs>('fs'), 'readFileSync').mockImplementation((file, options) =>
      file === '/proc/self/mountinfo' ? hostMountInfo : readFileSync(file, options));
    jest.replaceProperty(process, 'env', { ...process.env });
    delete process.env.DOCKER_CONTEXT;
    delete process.env.DOCKER_HOST;
    setAwfDockerHost(undefined);
    docker.mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function service(source = visibleDir, mode = 'rw') {
    return {
      volumes: [`${source}:/host/input:${mode}`], tmpfs: [], environment: {},
      healthcheck: { test: ['CMD-SHELL', 'true'] },
    };
  }

  test('no declarations preserve existing behavior', () => {
    config.privateHostSocketDirs = [];
    config.containerRuntime = 'sbx';
    const original = service();
    const snapshot = JSON.stringify(original);
    configurePrivateHostSocketIsolation(config, original);
    expect(JSON.stringify(original)).toBe(snapshot);
    expect(preparePrivateHostSocketIsolation(config)).toBeUndefined();
  });

  test('ordinary sibling paths install a gate before entrypoint and pin runc', () => {
    const generated = service();
    configurePrivateHostSocketIsolation(config, generated);
    expect(generated).toMatchObject({ entrypoint: ENTRYPOINT.map(arg => arg.replace(/\$/g, '$$$$')), runtime: 'runc' });
    expect(generated.tmpfs).toContain(`${CONTROL_DIR}:rw,noexec,nosuid,nodev,size=64k,mode=0711,uid=0,gid=0`);
    expect(generated).toMatchObject({ command: wrapPrivateHostSocketCommand(['/bin/bash', '-c', 'true']) });
    const wrapped = wrapPrivateHostSocketCommand(['/bin/bash', '-c', 'java -version']);
    expect(wrapped.slice(-3)).toEqual(['/bin/bash', '-c', 'java -version']);
  });

  test.each(['ro', 'rw'])('rejects parent, direct, and child exposure even with %s binds', mode => {
    const child = path.join(privateDir, 'nested');
    fs.mkdirSync(child);
    for (const source of [directory, privateDir, child]) {
      expect(() => configurePrivateHostSocketIsolation(config, service(source, mode))).toThrow('overlaps');
    }
  });

  test('a nested mask cannot rescue an exposing parent bind', () => {
    const generated = service(directory, 'ro');
    generated.volumes.push(`${visibleDir}:/host/input/private:ro`);
    expect(() => configurePrivateHostSocketIsolation(config, generated)).toThrow('overlaps');
  });

  test('resolves source and private-root symlink aliases', () => {
    const alias = path.join(directory, 'alias');
    fs.symlinkSync(privateDir, alias);
    expect(() => configurePrivateHostSocketIsolation(config, service(alias, 'ro'))).toThrow('overlaps');
    config.privateHostSocketDirs = [alias];
    expect(() => configurePrivateHostSocketIsolation(config, service(privateDir))).toThrow('overlaps');
  });

  test('rejects traversal and dangling or uninspectable sources', () => {
    config.privateHostSocketDirs = [`${privateDir}/../private`];
    expect(() => preparePrivateHostSocketIsolation(config)).toThrow('traversal');
    config.privateHostSocketDirs = [privateDir];
    const alias = path.join(directory, 'dangling');
    fs.symlinkSync(path.join(directory, 'absent'), alias);
    expect(() => configurePrivateHostSocketIsolation(config, service(alias))).toThrow();
    expect(() => configurePrivateHostSocketIsolation(config, service(`${visibleDir}/../private`))).toThrow('traversal');
    const malformed = service();
    malformed.volumes = ['opaque'];
    expect(() => configurePrivateHostSocketIsolation(config, malformed)).toThrow('mount syntax');
    expect(() => parseSocketMountInfo('uninspectable')).toThrow('mount table');
    expect(() => parseSocketMountInfo('')).toThrow('mount table');
  });

  test.each(['gvisor', 'runsc', 'sbx', 'cloud-hypervisor', 'nvx', 'kata', 'unknown'])(
    'fails closed for runtime %s', containerRuntime => {
      expect(() => assertPrivateHostSocketRuntime({ ...config, containerRuntime })).toThrow('Docker/runc');
    },
  );

  test.each(['/host', '/tmp', '/tmp/gh-aw'])('rejects host-path translation %s', dockerHostPathPrefix => {
    expect(() => assertPrivateHostSocketRuntime({ ...config, dockerHostPathPrefix })).toThrow('translation');
  });

  test('permits a no-op path prefix but rejects DinD, remote hosts, contexts, and unprivileged inspection', () => {
    expect(() => assertPrivateHostSocketRuntime({ ...config, dockerHostPathPrefix: '/' })).not.toThrow();
    for (const options of [
      { enableDind: true }, { runnerTopology: 'arc-dind' as const },
      { awfDockerHost: 'tcp://127.0.0.1:2375' }, { legacySecurity: true },
    ]) expect(() => assertPrivateHostSocketRuntime({ ...config, ...options })).toThrow();
    process.env.DOCKER_CONTEXT = 'remote';
    expect(() => assertPrivateHostSocketRuntime(config)).toThrow();
    delete process.env.DOCKER_CONTEXT;
    jest.spyOn(process, 'getuid').mockReturnValue(1001);
    expect(() => assertPrivateHostSocketRuntime(config)).toThrow('privileged host inspection');
  });

  test('rejects custom mounts that replace bootstrap interpreters or loader configuration', () => {
    for (const target of ['/bin', '/host/usr/bin/bash', '/etc/ld.so.preload', '/host', '/host/../../bin']) {
      expect(() => assertPrivateHostSocketRuntime({
        ...config, volumeMounts: [`${visibleDir}:${target}:ro`],
      })).toThrow();
    }
    expect(() => assertPrivateHostSocketRuntime({
      ...config, volumeMounts: [`${visibleDir}:/data:rw`],
    })).not.toThrow();
  });

  test.each(['rw', 'ro'])('rejects a symlink in a composed target below a %s bind', mode => {
    fs.symlinkSync('/usr/local/bin', path.join(visibleDir, 'link'));
    const generated = service(visibleDir, mode);
    generated.volumes.push(`${visibleDir}:/host/input/link/child:ro`);
    expect(() => configurePrivateHostSocketIsolation(config, generated)).toThrow('symlink in composed mount target');
  });

  test('refuses host network access and submounts inside the declared directory', () => {
    expect(() => assertPrivateHostSocketRuntime({ ...config, enableHostAccess: true })).toThrow('Docker control endpoints');
    const mounts = parseSocketMountInfo(`${hostMountInfo}\n3 1 8:2 / ${privateDir}/nested rw - ext4 /dev/other rw`);
    expect(() => readPrivateDirectories(config, mounts)).toThrow('descendant mounts');
  });

  test('kernel coordinates detect bind aliases and recursively included submounts', () => {
    const mounts = parseSocketMountInfo(hostMountInfo);
    const roots = readPrivateDirectories(config, mounts);
    const identity = coordinate(privateDir, mounts);
    const alias = { ...identity, mountPoint: '/host/tools/nested', propagation: [] };
    expect(() => assertDisjoint(roots, [alias])).toThrow('overlaps');
    expect(() => assertDisjoint(roots, [{ ...alias, root: path.dirname(identity.root) }])).toThrow('overlaps');
    expect(() => assertDisjoint(roots, [{ ...alias, root: path.join(identity.root, 'sockets') }])).toThrow('overlaps');
    expect(() => assertDisjoint(roots, [coordinate(visibleDir, mounts)])).not.toThrow();
  });

  test('mount-table escapes are decoded without hiding alias paths', () => {
    const [mount] = parseSocketMountInfo('1 0 8:1 /private\\040socket /alias\\040path ro - ext4 /dev/root ro');
    expect(mount.root).toBe('/private socket');
    expect(mount.mountPoint).toBe('/alias path');
    expect(parseSocketMountInfo('2 1 0:5 net:[1234] /run/docker/netns/id rw - nsfs nsfs rw')[0].filesystem).toBe('nsfs');
    expect(() => parseSocketMountInfo('1 0 8:1 relative /mount rw - ext4 /dev/root rw')).toThrow('invalid mount path');
    expect(() => coordinate(`${visibleDir}/../private`, parseSocketMountInfo(hostMountInfo))).toThrow('traversal');
  });

  test('refuses private directories on opaque filesystems', () => {
    const mounts = parseSocketMountInfo('1 0 0:1 / / rw - nfs server:/share rw');
    expect(() => readPrivateDirectories(config, mounts)).toThrow('unsupported host filesystem');
  });

  test('rejects ambiguous stacked host mounts instead of trusting a shadowed source', () => {
    const mounts = parseSocketMountInfo(hostMountInfo);
    const parent = coordinate(privateDir, mounts);
    const alias = { ...parent, mountPoint: privateDir };
    expect(() => coordinate(privateDir, [...mounts, alias, { ...alias, device: '0:123' }])).toThrow('stacked');
  });

  test('rejects recursively included host procfs even under an ordinary source', () => {
    const mounts = parseSocketMountInfo(hostMountInfo);
    const nested = parseSocketMountInfo(`123 1 0:123 / ${visibleDir}/proc rw - proc proc rw`)[0];
    expect(() => inspectHostSource(visibleDir, [...mounts, nested])).toThrow('nested host filesystem');
  });

  test('only verified container-root overlay aliases may enter the final topology', () => {
    const mounts = parseSocketMountInfo(hostMountInfo);
    const roots = readPrivateDirectories(config, mounts);
    const root = parseSocketMountInfo('1 0 0:456 / / rw - overlay overlay rw,lowerdir=/unused')[0];
    const safe = { ...root, root: '/usr/local/lib/token.so', mountPoint: '/host/run/token.so' };
    expect(() => assertAgentMountsIsolated(roots, [root, safe], root)).not.toThrow();
    expect(() => assertAgentMountsIsolated(roots, [root, { ...safe, device: '0:789' }], root)).toThrow('unsupported');
    expect(() => assertRootOverlayBackingsIsolated(
      roots, { ...root, superOptions: ['rw', `lowerdir=${privateDir}`] }, mounts, [visibleDir],
    )).toThrow('outside verified Docker storage');
    expect(() => assertRootOverlayBackingsIsolated(
      roots, { ...root, superOptions: ['rw'] }, mounts, [visibleDir],
    )).toThrow('uninspectable');
  });

  test('accepts verified containerd snapshotter backings without accepting arbitrary paths', () => {
    const mounts = parseSocketMountInfo(hostMountInfo);
    const roots = readPrivateDirectories(config, mounts);
    const dockerRoot = path.join(visibleDir, 'docker');
    const containerdRoot = path.join(visibleDir, 'containerd');
    const backing = path.join(containerdRoot, 'snapshots', '1', 'fs');
    fs.mkdirSync(dockerRoot);
    fs.mkdirSync(backing, { recursive: true });
    const root = parseSocketMountInfo(`1 0 0:456 / / rw - overlay overlay rw,lowerdir=${backing}`)[0];
    expect(dockerStoragePaths({
      DockerRootDir: '/var/lib/docker', Driver: 'overlayfs',
      DriverStatus: [['driver-type', 'io.containerd.snapshotter.v1']],
    })).toEqual(['/var/lib/docker', '/var/lib/containerd']);
    expect(dockerStoragePaths({ DockerRootDir: '/var/lib/docker', Driver: 'overlay2' }))
      .toEqual(['/var/lib/docker']);
    expect(dockerStoragePaths({ DockerRootDir: '/var/lib/docker', Driver: 'overlayfs', DriverStatus: [] }))
      .toEqual(['/var/lib/docker']);
    expect(() => dockerStoragePaths(null)).toThrow('uninspectable Docker storage');
    expect(() => assertRootOverlayBackingsIsolated(roots, root, mounts, [dockerRoot])).toThrow('outside verified');
    expect(() => assertRootOverlayBackingsIsolated(roots, root, mounts, [dockerRoot, containerdRoot])).not.toThrow();
    const privateBacking = { ...root, superOptions: [`lowerdir=${privateDir}`] };
    expect(() => assertRootOverlayBackingsIsolated(roots, privateBacking, mounts, [dockerRoot, containerdRoot]))
      .toThrow('outside verified');
    expect(() => assertRootOverlayBackingsIsolated(roots, privateBacking, mounts, [dockerRoot, directory]))
      .toThrow('overlaps');
  });

  test('refuses linked endpoints without changing authorized host access', async () => {
    const socketPath = path.join(privateDir, 'broker.sock');
    const server = net.createServer(socket => socket.end('adapter'));
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    try {
      fs.linkSync(socketPath, path.join(visibleDir, 'alias.sock'));
      expect(() => preparePrivateHostSocketIsolation(config)).toThrow('hard-linked sockets');
      fs.unlinkSync(path.join(visibleDir, 'alias.sock'));
      fs.symlinkSync(socketPath, path.join(privateDir, 'alias.sock'));
      expect(() => preparePrivateHostSocketIsolation(config)).toThrow('symlinks');
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  test('rejects bootstrap code injection and Docker control socket exposure', () => {
    const generated = { ...service(), environment: { LD_PRELOAD: '/host/input/inject.so' } };
    expect(() => configurePrivateHostSocketIsolation(config, generated)).toThrow('LD_PRELOAD');
    expect(() => configurePrivateHostSocketIsolation(config, service('/proc'))).toThrow('unsupported host filesystem');
    if (fs.existsSync('/var/run/docker.sock')) {
      expect(() => configurePrivateHostSocketIsolation(config, service('/var/run/docker.sock'))).toThrow('Docker control socket');
    }
  });

  test('clears exported functions and rejects Node startup options before Claude helper setup', () => {
    const generated = {
      ...service(),
      environment: { CLAUDE_CODE_API_KEY_HELPER: '/usr/local/bin/get-claude-key.sh', 'BASH_FUNC_node%%': '() { :; }' },
    };
    expect(() => configurePrivateHostSocketIsolation(config, {
      ...generated, environment: { ...generated.environment, NODE_OPTIONS: '--require /host/input/hook.js' },
    })).toThrow('NODE_OPTIONS');
    configurePrivateHostSocketIsolation(config, generated);
    expect(generated.environment).not.toHaveProperty('BASH_FUNC_node%%');
    expect(generated.environment).toHaveProperty('NODE_OPTIONS', '');
  });

  test('rejects root and malformed agent identities at the startup gate', () => {
    for (const uid of ['0', 'invalid']) {
      expect(() => configurePrivateHostSocketIsolation(config, {
        ...service(), environment: { AWF_USER_UID: uid },
      })).toThrow('unsupported agent identity');
    }
  });

  test('verification fails closed on missing container evidence before any release', async () => {
    const release = preparePrivateHostSocketIsolation(config)!;
    docker.mockResolvedValue({ stdout: '[]' } as never);
    await expect(release()).rejects.toThrow('inspection');
    expect(docker).toHaveBeenCalledTimes(1);
    expect(docker).toHaveBeenCalledWith('docker', ['inspect', 'awf-agent'], expect.objectContaining({
      env: expect.objectContaining({ DOCKER_HOST: 'unix:///var/run/docker.sock' }),
    }));
  });

  test.each([
    'release', 'unsupported-mount', 'missing-mount-source', 'private-mount',
    'bad-storage', 'missing-gate', 'bad-challenge', 'untrusted-image',
    'missing-root', 'stacked-root', 'setup-exited', 'setup-timeout', 'entrypoint-stopped',
    'propagation-change', 'changed-root', 'missing-final-gate', 'container-stopped',
  ])(
    'verifies the startup and command gates: %s', async scenario => {
      const storage = path.join(visibleDir, 'docker');
      const lower = path.join(storage, 'lower');
      const upper = path.join(storage, 'upper');
      const work = path.join(storage, 'work');
      const control = path.join(directory, 'control');
      for (const dir of [lower, upper, work, path.join(control, 'probe')]) fs.mkdirSync(dir, { recursive: true });
      fs.chmodSync(control, 0o711);
      fs.writeFileSync(path.join(control, 'probe', 'ready'), '');

      const procRoot = '/proc/123/root';
      const procControl = `${procRoot}${CONTROL_DIR}`;
      const rootMount = `10 1 0:456 / / rw - overlay overlay rw,lowerdir=${lower},upperdir=${upper},workdir=${work}`;
      const gateMount = `11 10 0:457 / ${CONTROL_DIR} rw - tmpfs tmpfs rw`;
      const mounts = `${rootMount}\n${gateMount}`;
      let mountReads = 0;
      const readFile = realReadFileSync;
      const stat = fs.statSync;
      const writeFile = fs.writeFileSync;
      const unlink = fs.unlinkSync;
      const exists = fs.existsSync;
      const actualFs = jest.requireActual<typeof fs>('fs');
      function mapped(file: fs.PathLike): fs.PathLike;
      function mapped(file: fs.PathOrFileDescriptor): fs.PathOrFileDescriptor;
      function mapped(file: fs.PathOrFileDescriptor): fs.PathOrFileDescriptor {
        return typeof file === 'string' && file.startsWith(procControl)
          ? control + file.slice(procControl.length) : file;
      }
      jest.spyOn(actualFs, 'readFileSync').mockImplementation((file, options) => {
        if (file === '/proc/self/mountinfo') return hostMountInfo;
        if (file === `${procRoot}/usr/local/bin/entrypoint.sh` && scenario === 'untrusted-image') {
          return 'old image without the chroot gate';
        }
        if (file === '/proc/123/mountinfo') {
          mountReads++;
          if (scenario === 'missing-root') return gateMount;
          if (scenario === 'stacked-root') return `${rootMount}\n${rootMount}\n${gateMount}`;
          if (scenario === 'missing-gate' && mountReads === 1) return rootMount;
          if (mountReads > 1) {
            if (scenario === 'propagation-change') return `${rootMount}\n${gateMount.replace(' rw - ', ' rw shared:1 - ')}`;
            if (scenario === 'changed-root') return `${rootMount.replace('0:456', '0:458')}\n${gateMount}`;
            if (scenario === 'missing-final-gate') return `${rootMount}\n${gateMount.replace('tmpfs tmpfs', 'ext4 /dev/test')}`;
          }
          return mounts;
        }
        return readFile(mapped(file as fs.PathLike), options);
      });
      jest.spyOn(actualFs, 'statSync').mockImplementation((file, options) => {
        const result = stat(mapped(file), options);
        if (file === procControl) Object.defineProperty(result, 'uid', { value: 0 });
        return result;
      });
      jest.spyOn(actualFs, 'writeFileSync').mockImplementation((file, data, options) =>
        writeFile(mapped(file), data, options));
      jest.spyOn(actualFs, 'unlinkSync').mockImplementation(file => unlink(mapped(file)));
      jest.spyOn(actualFs, 'existsSync').mockImplementation(file =>
        ['setup-exited', 'setup-timeout', 'entrypoint-stopped'].includes(scenario)
          && file === `${procControl}/probe/ready` ? false : exists(mapped(file)));
      if (['setup-exited', 'setup-timeout', 'entrypoint-stopped'].includes(scenario)) {
        let now = 0;
        jest.spyOn(Date, 'now').mockImplementation(() => { now += scenario === 'setup-timeout' ? 120001 : 1001; return now; });
      }
      const release = preparePrivateHostSocketIsolation(config)!;
      docker.mockResolvedValueOnce({ stdout: JSON.stringify([{
        Id: 'a'.repeat(64), State: { Running: true, Pid: 123 },
        HostConfig: { Runtime: 'runc', IpcMode: 'private' },
        Config: {
          Entrypoint: ENTRYPOINT, Cmd: wrapPrivateHostSocketCommand(['/bin/true']),
          Env: [
            'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
            ...(scenario === 'untrusted-image' ? ['AWF_CHROOT_ENABLED=true'] : []),
          ],
        },
        Mounts: scenario === 'unsupported-mount' ? [{ Type: 'volume', Driver: 'remote' }] :
          scenario === 'missing-mount-source' ? [{ Type: 'bind' }] :
          scenario === 'private-mount' ? [{ Type: 'bind', Source: privateDir }] :
          [{ Type: 'tmpfs' }, { Type: 'bind', Source: visibleDir }],
      }]) } as never)
        .mockResolvedValueOnce({ stdout: JSON.stringify({ DockerRootDir: scenario === 'bad-storage' ? 'relative' : storage }) } as never)
        .mockImplementationOnce(() => Promise.resolve({
          stdout: scenario === 'bad-challenge' ? 'wrong' : readFile(path.join(control, 'challenge'), 'utf8'),
        }) as never)
        .mockResolvedValueOnce({ stdout: scenario === 'setup-exited' ? 'exited 42' :
          scenario === 'entrypoint-stopped' ? 'exited 0' :
          scenario === 'container-stopped' ? '123 false' : '123 true' } as never);

      if (scenario === 'release') {
        await expect(release()).resolves.toBeUndefined();
        expect(fs.existsSync(path.join(control, 'allow'))).toBe(true);
      } else if (scenario === 'setup-exited') {
        await expect(release()).resolves.toBe('setup-exited');
        expect(fs.existsSync(path.join(control, 'allow'))).toBe(false);
      } else {
        const expected: Record<string, string> = {
          'bad-storage': 'uninspectable Docker storage',
          'unsupported-mount': 'unsupported actual container topology',
          'missing-mount-source': 'uninspectable actual mount source',
          'private-mount': 'overlaps a private directory',
          'missing-gate': 'missing private startup gate',
          'bad-challenge': 'do not share an inspectable filesystem',
          'untrusted-image': 'agent image does not support',
          'missing-root': 'uninspectable container root mount',
          'stacked-root': 'uninspectable container root mount',
          'setup-timeout': 'post-setup command gate was not reached',
          'entrypoint-stopped': 'entrypoint exited before the command gate',
          'propagation-change': 'propagating post-setup',
          'changed-root': 'container root mount changed',
          'missing-final-gate': 'missing final command gate',
          'container-stopped': 'container changed during inspection',
        };
        await expect(release()).rejects.toThrow(expected[scenario]);
        expect(fs.existsSync(path.join(control, 'allow'))).toBe(false);
      }
    },
  );

  test.each([
    { HostConfig: { Runtime: 'runsc' } },
    { HostConfig: { Runtime: 'runc', Privileged: true } },
    { HostConfig: { Runtime: 'runc', PidMode: 'host' } },
    { HostConfig: { Runtime: 'runc', IpcMode: 'host' } },
    { Config: { Entrypoint: ['/bin/bash', '-c', 'untrusted'] } },
  ])('rejects unsupported final topology %j', override => {
    const release = preparePrivateHostSocketIsolation(config)!;
    docker.mockResolvedValue({ stdout: JSON.stringify([{
      Id: 'a'.repeat(64), State: { Running: true, Pid: 123 },
      HostConfig: { Runtime: 'runc', IpcMode: 'private' },
      Config: {
        Entrypoint: ENTRYPOINT, Cmd: wrapPrivateHostSocketCommand(['/bin/true']),
        Env: ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'],
      }, Mounts: [], ...override,
    }]) } as never);
    return expect(release()).rejects.toThrow('actual container topology');
  });
});
