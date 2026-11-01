/**
 * No inference or credentials: supply a locally built enclave-agent image via
 * AWF_DOCKER_ENCLAVE_NATIVE_LOAD_IMAGE and run as root with CAP_SYS_ADMIN.
 * Uses production host storage and container security settings, not a Copilot double.
 */
import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  mountDockerHostStorage, unmountDockerHostStorage,
  type DockerHostMountIdentity,
} from '../../src/enclave/docker-host-storage';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { deriveEnclaveContainerSpec } = require('../../containers/enclave/agent-executor/enclave-runner-spec.js');
const image = process.env.AWF_DOCKER_ENCLAVE_NATIVE_LOAD_IMAGE;
const acceptance = image ? describe : describe.skip;
const root = path.resolve(__dirname, '../..');
const pinnedVersion = JSON.parse(fs.readFileSync(path.join(root, 'containers/enclave/package.json'), 'utf8'))
  .dependencies['@github/copilot'];

const probe = `
import errno, mmap, os, shutil, subprocess
from pathlib import Path
assert (os.geteuid(), os.getegid()) == (65534, 65534)
assert os.environ["HOME"] == "/agent/home"
assert os.environ["COPILOT_HOME"] == "/agent/copilot"
status = Path("/proc/self/status").read_text()
assert "NoNewPrivs:\\t1" in status and "CapEff:\\t0000000000000000" in status
mounts = {f[1]: f[3].split(",") for f in
          (line.split() for line in Path("/proc/mounts").read_text().splitlines())}
assert "ro" in mounts["/"]
for target in ["/agent", "/tmp"]:
    assert all(flag in mounts[target] for flag in ["rw", "noexec", "nosuid", "nodev"])
Path("/agent/home").mkdir()
Path("/agent/copilot").mkdir()
runtime = Path(os.environ["COPILOT_CLI_DIST_DIR"]).resolve()
assert str(runtime).startswith("/usr/local/lib/node_modules/@github/copilot/cache/pkg/")
for target in [runtime, *runtime.rglob("*")]:
    assert target.stat().st_uid == 0 and target.stat().st_mode & 0o222 == 0
addons = list(runtime.glob("**/runtime.node"))
assert addons, "pinned native addon absent"
addon = addons[0]
with addon.open("rb") as f:
    with mmap.mmap(f.fileno(), 4096, flags=mmap.MAP_PRIVATE,
                   prot=mmap.PROT_READ | mmap.PROT_EXEC): pass
for directory in ["/agent", "/tmp"]:
    copy = Path(directory) / "native-mapping-probe.node"
    shutil.copyfile(addon, copy)
    assert copy.read_bytes() == addon.read_bytes()
    try:
        with copy.open("rb") as f:
            with mmap.mmap(f.fileno(), 4096, flags=mmap.MAP_PRIVATE,
                           prot=mmap.PROT_READ | mmap.PROT_EXEC): pass
        raise AssertionError("writable executable mapping succeeded")
    except OSError as error:
        assert error.errno == errno.EPERM, error
    finally:
        copy.unlink()
for flag in ["--version", "--help"]:
    result = subprocess.run(["/usr/local/bin/copilot", "--no-auto-update", flag],
                            capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr
    if flag == "--version":
        assert "GitHub Copilot CLI ${pinnedVersion}" in result.stdout
assert not Path("/agent/home/.cache/copilot").exists()
print("pinned Copilot native load and writable noexec checks passed")
`;

acceptance('Docker enclave pinned Copilot native bootstrap', () => {
  test('loads immutable native addons while writable mounts reject PROT_EXEC', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-native-load-'));
    const runId = randomBytes(16).toString('hex');
    const invocationId = 'native-load';
    const network = `awf-native-load-${runId}`;
    const seedId = 'a'.repeat(32);
    const docker = (args: string[]) => execFileSync('docker', args, {
      encoding: 'utf8', timeout: 90_000, maxBuffer: 1024 * 1024,
      env: { PATH: '/usr/bin:/bin', DOCKER_HOST: process.env.DOCKER_HOST, HOME: directory },
    }).trim();
    let mount: DockerHostMountIdentity | undefined;
    let containerName: string | undefined;
    let networkCreated = false;
    try {
      mount = await mountDockerHostStorage(path.join(directory, 'storage'), `awf-native-${runId}`, 256 * 1024 ** 2);
      const invocation = path.join(mount.target, invocationId);
      fs.mkdirSync(invocation);
      for (const name of ['agent', 'out']) {
        const target = path.join(invocation, name);
        fs.mkdirSync(target, { mode: 0o700 });
        fs.chownSync(target, 65534, 65534);
      }
      for (const name of ['task.txt', 'schema.json', 'session.jsonl']) {
        const target = path.join(invocation, name);
        fs.writeFileSync(target, '', { mode: 0o600 });
        fs.chownSync(target, 65534, 65534);
      }
      fs.mkdirSync(path.join(directory, 'seeds', seedId), { recursive: true, mode: 0o755 });
      docker(['network', 'create', '--internal', network]);
      networkCreated = true;
      const spec = deriveEnclaveContainerSpec({
        runId, invocationId, seedId,
        config: {
          hostWorkDir: mount.target, hostSeedsDir: path.join(directory, 'seeds'),
          enclaveImage: image, enclaveUid: 65534, enclaveGid: 65534,
          enclaveSeccompPath: path.join(root, 'containers/enclave/seccomp.json'),
          network, memoryLimit: '1g', cpuLimit: 1, pidsLimit: 128, tmpfsLimit: '256m',
          enclaveMountDir: '/agent', enclaveSeedPath: '/awf/seed',
          enclaveTaskPath: '/awf/task.txt', enclaveSchemaPath: '/awf/schema.json',
          engine: 'copilot', apiEndpoint: 'http://127.0.0.1:1', profile: 'openai',
          model: 'unused', timeoutSeconds: 60, maxOutputBytes: 2048,
        },
      });
      containerName = spec.containerName;
      const args = [...spec.launchArgs];
      // Replace only the workload: all production mounts/security flags remain.
      args[args.indexOf('--entrypoint') + 1] = '/usr/bin/python3';
      expect(docker([...args, '-c', probe])).toContain('pinned Copilot native load and writable noexec checks passed');
    } finally {
      // Storage is released only after daemon-confirmed container removal.
      if (containerName) {
        docker(['rm', '-f', containerName]);
        expect(docker(['ps', '-aq', '--filter', `name=^/${containerName}$`])).toBe('');
      }
      if (networkCreated) docker(['network', 'rm', network]);
      if (mount) await unmountDockerHostStorage(mount);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);
});
