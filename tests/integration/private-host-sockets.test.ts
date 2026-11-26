import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import execa from 'execa';
import * as yaml from 'js-yaml';
import {
  configurePrivateHostSocketIsolation, preparePrivateHostSocketIsolation,
  privateSocketTestHelpers,
} from '../../src/private-host-sockets';
import type { WrapperConfig } from '../../src/types';

const privilegedLinuxTests = process.platform === 'linux' && process.getuid?.() === 0 ? describe : describe.skip;

privilegedLinuxTests('live trusted host socket boundary (local privileged Docker/runc)', () => {
  let directory: string;
  const servers: net.Server[] = [];

  beforeAll(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-socket-live-'));
    fs.chmodSync(directory, 0o755);
  });

  afterEach(async () => {
    await execa('docker', ['rm', '-f', 'awf-agent'], { reject: false });
    for (const server of servers.splice(0)) {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

  async function startSocket(socketPath: string): Promise<void> {
    const server = net.createServer(socket => socket.end('authorized-adapter'));
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    servers.push(server);
  }

  async function adapterConnect(socketPath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(socketPath);
      let received = '';
      socket.on('data', chunk => { received += chunk.toString(); });
      socket.on('error', reject);
      socket.on('end', () => resolve(received));
    });
  }

  async function startAgent(service: Parameters<typeof configurePrivateHostSocketIsolation>[1], command: string): Promise<void> {
    const composeFile = path.join(directory, 'compose.yml');
    fs.writeFileSync(composeFile, yaml.dump({
      services: {
        agent: {
          ...service, image: 'ghcr.io/github/gh-aw-firewall/agent:latest',
          container_name: 'awf-agent', network_mode: 'none',
          command: privateSocketTestHelpers.wrapPrivateHostSocketCommand(['/bin/bash', '-c', command.replace(/\$/g, '$$$$')]),
        },
      },
    }));
    await execa('docker', ['compose', '--project-name', 'awf-private-socket-live', '-f', composeFile, 'up', '-d']);
  }

  test.each([false, true])('same-UID adapter connects but the agent cannot connect (chroot=%s)', async chroot => {
    const privateDir = path.join(directory, `private-${chroot}`);
    const visibleDir = path.join(directory, `visible-${chroot}`);
    fs.mkdirSync(privateDir, { mode: 0o700 });
    fs.mkdirSync(visibleDir, { mode: 0o777 });
    fs.chmodSync(visibleDir, 0o777);
    const uid = Number(process.env.SUDO_UID || 1001);
    const gid = Number(process.env.SUDO_GID || 1001);
    fs.chownSync(privateDir, uid, gid);
    fs.chownSync(visibleDir, uid, gid);
    const existing = path.join(privateDir, 'broker.sock');
    const late = path.join(privateDir, 'late.sock');
    await startSocket(existing);
    fs.chownSync(existing, uid, gid);
    const config: WrapperConfig = {
      allowedDomains: [], workDir: path.join(directory, 'work'), agentCommand: 'true',
      keepContainers: false, logLevel: 'error', privateHostSocketDirs: [privateDir],
    };
    const service = {
      volumes: [`${visibleDir}:${chroot ? '/host' : ''}/visible:rw`], tmpfs: [],
      environment: {
        AWF_CHROOT_ENABLED: String(chroot), AWF_SKIP_IPTABLES_INIT: '1',
        AWF_USER_UID: String(uid), AWF_USER_GID: String(gid),
        HOME: '/home/runner',
      },
      healthcheck: { test: ['CMD-SHELL', 'true'] },
      entrypoint: [] as string[],
    };
    if (chroot) {
      const home = path.join(directory, 'chroot-home');
      fs.mkdirSync(home);
      fs.chownSync(home, uid, gid);
      service.volumes.push(`${home}:/host/home/runner:rw`);
      for (const source of [
        '/usr', '/bin', '/sbin', '/lib', '/lib64', '/sys', '/dev',
        '/etc/passwd', '/etc/group', '/etc/nsswitch.conf', '/etc/hosts', '/etc/ssl/certs',
      ]) service.volumes.push(`${source}:/host${source}:ro`);
      (service.tmpfs as string[]).push('/host/tmp:rw,exec,nosuid,nodev,size=64m');
      Object.assign(service, {
        cap_add: ['SYS_ADMIN', 'SYS_CHROOT'], security_opt: ['apparmor:unconfined', 'no-new-privileges:true'],
      });
    }
    configurePrivateHostSocketIsolation(config, service);
    const release = preparePrivateHostSocketIsolation(config)!;
    await startAgent(service, `
python3 - <<'PY'
import errno, os, socket
assert os.getuid() == ${uid}
assert 'python' in os.path.basename(os.readlink('/proc/self/exe'))
for target in (${JSON.stringify(existing)}, ${JSON.stringify(late)}, '/visible/../private/broker.sock'):
    with socket.socket(socket.AF_UNIX) as s:
        try:
            s.connect(target)
        except OSError as error:
            assert error.errno == errno.ENOENT, (target, error)
        else:
            raise AssertionError('agent connected to trusted socket')
with open('/visible/command-ran', 'w') as f:
    f.write('isolated')
print('agent socket connections denied')
PY`);
    expect(fs.existsSync(path.join(visibleDir, 'command-ran'))).toBe(false);
    await startSocket(late);
    fs.chownSync(late, uid, gid);

    // Run the authorized host adapter as the same UID as the agent: directory
    // mode and a different host identity are not the reason for isolation.
    for (const socketPath of [existing, late]) {
      const connected = await execa('sudo', ['-u', `#${uid}`, 'python3', '-c',
        'import socket,sys; s=socket.socket(socket.AF_UNIX); s.connect(sys.argv[1]); print(s.recv(64).decode())',
        socketPath]);
      expect(connected.stdout).toBe('authorized-adapter');
    }
    await release();
    const exited = await execa('docker', ['wait', 'awf-agent'], { timeout: 30000 });
    const logs = await execa('docker', ['logs', 'awf-agent']);
    expect(exited.stdout).toBe('0');
    expect(logs.stdout).toContain('agent socket connections denied');
    expect(fs.readFileSync(path.join(visibleDir, 'command-ran'), 'utf8')).toBe('isolated');
    expect(await adapterConnect(existing)).toBe('authorized-adapter');
    expect(await adapterConnect(late)).toBe('authorized-adapter');
  }, 60000);

  test('a late-added read-only alias is rejected before the command runs', async () => {
    const privateDir = path.join(directory, 'late-private');
    const visibleDir = path.join(directory, 'late-visible');
    fs.mkdirSync(privateDir);
    fs.mkdirSync(visibleDir);
    const config: WrapperConfig = {
      allowedDomains: [], workDir: path.join(directory, 'late-work'), agentCommand: 'true',
      keepContainers: false, logLevel: 'error', privateHostSocketDirs: [privateDir],
    };
    const service = {
      volumes: [`${visibleDir}:/visible:rw`], tmpfs: [], environment: {},
      healthcheck: { test: ['CMD-SHELL', 'true'] }, entrypoint: [] as string[],
    };
    configurePrivateHostSocketIsolation(config, service);
    const release = preparePrivateHostSocketIsolation(config)!;
    service.volumes.push(`${privateDir}:/unexpected-alias:ro`);
    await startAgent(service, 'echo COMMAND_RAN');
    await expect(release()).rejects.toThrow('overlaps');
    const logs = await execa('docker', ['logs', 'awf-agent']);
    expect(logs.stdout).not.toContain('COMMAND_RAN');
  }, 60000);

  test('replacement of a declared directory during startup cannot open the gate', async () => {
    const privateDir = path.join(directory, 'replaced-private');
    fs.mkdirSync(privateDir);
    const config: WrapperConfig = {
      allowedDomains: [], workDir: path.join(directory, 'replaced-work'), agentCommand: 'true',
      keepContainers: false, logLevel: 'error', privateHostSocketDirs: [privateDir],
    };
    const service = {
      volumes: [] as string[], tmpfs: [], environment: {},
      healthcheck: { test: ['CMD-SHELL', 'true'] }, entrypoint: [] as string[],
    };
    configurePrivateHostSocketIsolation(config, service);
    const release = preparePrivateHostSocketIsolation(config)!;
    await startAgent(service, 'echo COMMAND_RAN');
    fs.renameSync(privateDir, privateDir + '-old');
    fs.mkdirSync(privateDir);
    await expect(release()).rejects.toThrow('changed during startup');
    const logs = await execa('docker', ['logs', 'awf-agent']);
    expect(logs.stdout).not.toContain('COMMAND_RAN');
  }, 60000);

  test('a propagation change during entrypoint setup is rejected by the final gate', async () => {
    const privateDir = path.join(directory, 'post-setup-private');
    const initDir = path.join(directory, 'post-setup-init');
    fs.mkdirSync(privateDir);
    fs.mkdirSync(initDir);
    const config: WrapperConfig = {
      allowedDomains: [], workDir: path.join(directory, 'post-setup-work'), agentCommand: 'true',
      keepContainers: false, logLevel: 'error', privateHostSocketDirs: [privateDir],
    };
    const service = {
      volumes: [`${initDir}:/run/awf-init:rw`], tmpfs: [],
      environment: { AWF_CHROOT_ENABLED: 'false', AWF_USER_UID: '1001', AWF_USER_GID: '1001' },
      healthcheck: { test: ['CMD-SHELL', 'true'] }, entrypoint: [] as string[],
      cap_add: ['SYS_ADMIN'], security_opt: ['apparmor:unconfined'],
    };
    configurePrivateHostSocketIsolation(config, service);
    const release = preparePrivateHostSocketIsolation(config)!;
    await startAgent(service, 'echo COMMAND_RAN; touch /run/awf-private-host-sockets/probe/command-ran');
    const pid = (await execa('docker', ['inspect', '--format', '{{.State.Pid}}', 'awf-agent'])).stdout;
    const released = release();
    void released.catch(() => undefined);
    // The real entrypoint waits for iptables readiness. Mutate the namespace
    // after initial verification but before its post-setup command gate.
    const deadline = Date.now() + 10000;
    const control = `/proc/${pid}/root/run/awf-private-host-sockets`;
    while (!fs.existsSync(path.join(control, 'allow-setup'))) {
      if (Date.now() >= deadline) throw new Error('Initial socket gate was not released');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await execa('docker', ['exec', 'awf-agent', '/bin/mount', '--make-shared', '/run/awf-init']);
    fs.writeFileSync(path.join(initDir, 'ready'), '');
    await expect(released).rejects.toThrow('propagating post-setup');
    expect(fs.existsSync(path.join(control, 'probe', 'command-ran'))).toBe(false);
  }, 60000);
});
