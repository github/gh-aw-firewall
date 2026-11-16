import { spawn, ChildProcess } from 'child_process';
import { once } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import execa from 'execa';
import { generateDockerCompose } from '../../src/compose-generator';
import { prepareChrootHomeMountpoint } from '../../src/chroot-home-setup';

describe('host CoreCLR IPC isolation', () => {
  let directory: string;
  const processes: ChildProcess[] = [];

  async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 30000;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error('Timed out waiting for IPC regression fixture');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async function startDotnet(tmpDir = '/tmp'): Promise<string[]> {
    const process = spawn('dotnet', [path.join(directory, 'app/out/ipc-fixture.dll')], {
      env: {
        ...global.process.env, TMPDIR: tmpDir,
        DOTNET_EnableDiagnostics: '1', COMPlus_EnableDiagnostics: '1',
      },
      stdio: 'ignore',
    });
    processes.push(process);
    const endpoints = () => fs.readdirSync(tmpDir).filter((name) =>
      name.startsWith(`clr-debug-pipe-${process.pid}-`) ||
      name.startsWith(`dotnet-diagnostic-${process.pid}-`));
    await waitFor(() => endpoints().length >= 3);
    return endpoints();
  }

  beforeAll(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-coreclr-'));
    await execa('dotnet', ['new', 'console', '--name', 'ipc-fixture', '--output',
      path.join(directory, 'app'), '--no-restore']);
    fs.writeFileSync(path.join(directory, 'app/Program.cs'), 'System.Threading.Thread.Sleep(-1);\n');
    await execa('dotnet', ['build', path.join(directory, 'app'), '--output',
      path.join(directory, 'app/out'), '--ignore-failed-sources', '--disable-build-servers']);
  }, 120000);

  afterEach(async () => {
    for (const process of processes.splice(0)) {
      if (process.exitCode === null) {
        const exited = once(process, 'exit');
        process.kill();
        await exited;
      }
    }
    fs.rmSync(path.join(directory, 'ready'), { force: true });
    fs.rmSync(path.join(directory, 'endpoints.json'), { force: true });
  });

  afterAll(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test.each([false, true])('isolates existing and late-created IPC (chroot=%s)', async (chroot) => {
    const existing = await startDotnet();
    const workDir = path.join(directory, `work-${chroot}`);
    const home = path.join(directory, 'home');
    fs.mkdirSync(workDir, { mode: 0o700 });
    const service = generateDockerCompose({
      allowedDomains: [], agentCommand: 'true', workDir, keepContainers: false,
      buildLocal: false, logLevel: 'error',
      volumeMounts: [`${directory}:/ipc-test:rw`],
    }, {
      subnet: '172.30.0.0/24', agentIp: '172.30.0.20', squidIp: '172.30.0.10',
    }, undefined, undefined, { effectiveHome: home }).services.agent;

    // Keep the live handoff fixture local: Docker must not create root-owned
    // mask mountpoints in the runner's real /tmp/gh-aw during this test.
    const handoffRoot = path.join(directory, 'gh-aw');
    const volumes = (service.volumes || []).map((volume) =>
      volume.startsWith('/tmp/gh-aw:') ? volume.replace('/tmp/gh-aw:', `${handoffRoot}:`) : volume);
    for (const tmpfs of service.tmpfs || []) {
      const target = tmpfs.split(':')[0].replace(/^\/host(?=\/)/, '');
      if (target.startsWith('/tmp/gh-aw/')) {
        fs.mkdirSync(path.join(handoffRoot, path.posix.relative('/tmp/gh-aw', target)), { recursive: true });
      }
    }
    const entrypoint = path.resolve(__dirname, '../../containers/agent/entrypoint.sh');
    const args = ['run', '--rm', '--network', 'none'];
    for (const volume of volumes) {
      const source = volume.split(':')[0];
      if (source.startsWith(`${directory}/`) && !fs.existsSync(source)) {
        fs.mkdirSync(source, { recursive: true });
      }
      args.push('--volume', volume);
    }
    // Mirror AWF's home preparation so Docker never creates root-owned
    // placeholders inside the fixture's writable empty-home bind.
    for (const volume of volumes) {
      const [source, target] = volume.split(':');
      if (!target.startsWith(`/host${home}/`)) continue;
      const relative = path.posix.relative(`/host${home}`, target);
      prepareChrootHomeMountpoint(`${workDir}-chroot-home`,
        fs.statSync(source).isDirectory() ? relative : path.dirname(relative),
        process.getuid!(), process.getgid!());
    }
    for (const tmpfs of service.tmpfs || []) args.push('--tmpfs', tmpfs);
    args.push('--volume', `${entrypoint}:/run/ipc-entrypoint.sh:ro`,
      '--volume', `${entrypoint}:/host/run/ipc-entrypoint.sh:ro`,
      '--env', `HOME=${home}`, '--env', 'TMPDIR=/tmp',
      '--env', 'RUNNER_TEMP=/tmp/runner-temp');
    const identity = `${process.getuid!()}:${process.getgid!()}`;
    if (chroot) {
      args.push('--entrypoint', 'chroot', service.image!,
        `--userspec=${identity}`, '/host', '/bin/bash', '-c');
    } else {
      args.push('--user', identity, '--entrypoint', '/bin/bash', service.image!, '-c');
    }
    const handoff = chroot ? '/ipc-test' : '/host/ipc-test';
    args.push(`
set -e
source /run/ipc-entrypoint.sh
check_host_runtime_ipc
touch ${handoff}/ready
for ((i=0; i<300; i++)); do
  [ ! -f ${handoff}/endpoints.json ] || break
  sleep 0.1
done
python3 - <<'PY'
import errno, json, os, socket, stat
assert os.getuid() == ${process.getuid!()}
with open('${handoff}/endpoints.json') as f:
    endpoints = json.load(f)
for root in ('/tmp', '/host/tmp', os.environ['TMPDIR']):
    for name in endpoints:
        target = root + '/' + name
        assert not os.path.lexists(target), target
        try:
            if name.startswith('clr-debug-pipe-'):
                fd = os.open(target, os.O_RDWR | os.O_NONBLOCK)
                os.close(fd)
            else:
                with socket.socket(socket.AF_UNIX) as s:
                    s.connect(target)
        except OSError as error:
            assert error.errno == errno.ENOENT, (target, error)
        else:
            raise AssertionError('Opened host runtime IPC: ' + target)
assert stat.S_IMODE(os.stat('/tmp').st_mode) == 0o1777
os.mkfifo('/tmp/agent-local-fifo')
fd = os.open('/tmp/agent-local-fifo', os.O_RDWR | os.O_NONBLOCK)
os.close(fd)
with socket.socket(socket.AF_UNIX) as s:
    s.bind('/tmp/agent-local-socket')
print('host IPC isolated; agent IPC and handoff work')
PY
`);
    const container = execa('docker', args, { timeout: 60000, reject: false });
    // Surface early container failures rather than waiting only for its marker.
    await Promise.race([
      waitFor(() => fs.existsSync(path.join(directory, 'ready'))),
      container.then((result) => { throw new Error(result.stderr || result.stdout); }),
    ]);
    const late = await startDotnet();
    fs.writeFileSync(path.join(directory, 'endpoints.json'), JSON.stringify([...existing, ...late]));
    const result = await container;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('host IPC isolated; agent IPC and handoff work');
    for (const name of [...existing, ...late]) {
      expect(fs.existsSync(path.join('/tmp', name))).toBe(true);
    }

    // An intentional live share is not an IPC boundary. Verify that the
    // preflight catches host diagnostics exposed through a custom TMPDIR.
    const exposed = await startDotnet(directory);
    args[args.indexOf('TMPDIR=/tmp')] = `TMPDIR=${handoff}`;
    args[args.length - 1] = 'source /run/ipc-entrypoint.sh; check_host_runtime_ipc; echo COMMAND_LAUNCHED';
    const refused = await execa('docker', args, { timeout: 60000, reject: false });
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain('CoreCLR debug/diagnostic IPC is visible');
    expect(refused.stdout).not.toContain('COMMAND_LAUNCHED');
    for (const name of exposed) expect(fs.existsSync(path.join(directory, name))).toBe(true);
  }, 120000);
});
