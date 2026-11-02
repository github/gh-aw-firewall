import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const script = path.join(__dirname, 'enclave-installer-node.sh');

describe('trusted enclave installer Node bootstrap', () => {
  let temp: string;
  beforeEach(() => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-installer-node-'));
  });
  afterEach(() => fs.rmSync(temp, { recursive: true, force: true }));

  function shell(body: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
    return spawnSync('/bin/bash', ['-c', 'source "$1"; shift; ' + body, 'test', script, ...args], {
      encoding: 'utf8', env: { PATH: '/usr/bin:/bin', ...env },
    });
  }

  function runtime(metadata: string) {
    const file = path.join(temp, 'node');
    fs.writeFileSync(file, `#!/bin/bash
[[ -z "\${NODE_OPTIONS:-}\${NODE_PATH:-}\${LD_PRELOAD:-}\${HOME:-}" ]] || exit 91
[[ "$1" == --no-addons && "$2" == --no-global-search-paths && "$3" == -p ]] || exit 92
printf '%s\\n' '${metadata}'
`, { mode: 0o755 });
    return file;
  }

  it.each([
    ['x86_64', 'x64'], ['amd64', 'x64'], ['aarch64', 'arm64'], ['arm64', 'arm64'],
  ])('maps Linux %s to the setup-node cache architecture %s', (host, expected) => {
    const result = shell('node_architecture "$1"', [host]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(expected);
  });

  it('rejects unsupported architectures', () => {
    const result = shell('node_architecture riscv64');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Only Linux x64 and ARM64');
  });

  it.each(['x64', 'arm64'])('reuses an installed %s runtime before inspecting the cache', arch => {
    const candidate = runtime(`linux:${arch}:24.1.0`);
    const result = shell(`
      node_paths=("$1"); node_arch=$2; tool_cache="$3"
      trusted_path() { [[ "$1" == "${candidate}" ]] && printf '%s\\n' "$1"; }
      find_node
    `, [candidate, arch, path.join(temp, 'missing-cache')]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(candidate);
  });

  it.each(['x64', 'arm64'])('selects a matching %s cache hit when installed runtimes are unsuitable', arch => {
    const cache = path.join(temp, 'cache');
    const candidate = path.join(cache, 'node', '24.1.0', arch, 'bin', 'node');
    fs.mkdirSync(path.dirname(candidate), { recursive: true });
    fs.copyFileSync(runtime(`linux:${arch}:24.1.0`), candidate);
    const result = shell(`
      node_paths=(); node_arch=$2; tool_cache=$3
      trusted_path() { [[ "$1" == "$expected_candidate" ]] && printf '%s\\n' "$1"; }
      expected_candidate=$1
      find_node
    `, [candidate, arch, cache]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(candidate);
  });

  it.each([
    ['linux:x64:20.19.0', true], ['linux:x64:22.0.0', true],
    ['linux:x64:20.18.9', false], ['linux:x64:18.20.0', false],
    ['linux:arm64:24.1.0', false], ['darwin:x64:24.1.0', false],
    ['linux:x64:24.1.0-rc.1', false], ['garbage', false],
  ])('checks actual runtime metadata %s', (metadata, accepted) => {
    const candidate = runtime(metadata);
    const result = shell(`
      node_arch=x64
      trusted_path() { printf '%s\\n' "$1"; }
      probe_node "$1"
    `, [candidate]);
    expect(result.status === 0).toBe(accepted);
  });

  it('clears Node startup injection and uses restrictive interpreter flags', () => {
    const candidate = runtime('linux:x64:24.1.0');
    const result = shell(`
      node_arch=x64
      trusted_path() { printf '%s\\n' "$1"; }
      probe_node "$1"
    `, [candidate], { NODE_OPTIONS: '--require=/untrusted.cjs', NODE_PATH: temp, HOME: temp });
    expect(result.status).toBe(0);
  });

  it('never probes a runner-writable executable, even if it reports a compatible version', () => {
    const marker = path.join(temp, 'executed');
    const candidate = path.join(temp, 'node');
    fs.writeFileSync(candidate, `#!/bin/sh\ntouch '${marker}'\necho linux:x64:24.1.0\n`, { mode: 0o755 });
    expect(shell('node_arch=x64; probe_node "$1"', [candidate]).status).not.toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('resolves aliases to a protected canonical path rather than returning a writable symlink', () => {
    const alias = path.join(temp, 'alias');
    const target = fs.realpathSync('/usr/bin/env');
    fs.symlinkSync(target, alias);
    const result = shell('trusted_path "$1"', [alias]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(target);
  });

  it('rejects missing paths and writable ancestors', () => {
    expect(shell('trusted_path "$1"', [path.join(temp, 'missing')]).status).not.toBe(0);
    expect(shell('trusted_path "$1"', [runtime('linux:x64:24.1.0')]).status).not.toBe(0);
    // A root-owned sticky directory is still writable by the runner.
    expect(shell('trusted_path /tmp').status).not.toBe(0);
  });

  it('does not install anything on an installed-runtime or cache hit', () => {
    const result = shell(`
      install=true
      find_node() { printf '/protected/node\\n'; }
      install_node() { echo unexpected-install >&2; return 1; }
      resolve_node
    `);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('/protected/node');
    expect(result.stderr).toBe('');
  });

  it('uses the package manager only after a miss and validates its result again', () => {
    const installed = path.join(temp, 'installed');
    const result = shell(`
      install=true
      find_node() { [[ -f "${installed}" ]] && printf '/protected/node\\n'; }
      install_node() { /usr/bin/touch "${installed}"; }
      resolve_node
    `);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('/protected/node');
  });

  it.each(['true', 'false'])('fails clearly when no trusted compatible runtime is available (install=%s)', install => {
    const result = shell(`
      install=$1
      find_node() { return 1; }
      install_node() { return 0; }
      resolve_node
    `, [install]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('No trusted compatible Node >=20.19');
    expect(result.stdout).toBe('');
  });

  it('delegates acquisition and caching to authenticated APT with a clean environment', () => {
    const apt = path.join(temp, 'apt-get');
    const log = path.join(temp, 'apt.log');
    fs.writeFileSync(apt, `#!/bin/bash
[[ -z "\${APT_CONFIG:-}\${NODE_OPTIONS:-}\${HOME:-}" ]] || exit 91
[[ "$DEBIAN_FRONTEND" == noninteractive ]] || exit 92
printf '%s\\n' "$*" >> '${log}'
`, { mode: 0o755 });
    const result = shell(`
      apt_path=$1
      trusted_path() { [[ "$1" == /usr/bin/apt-get ]] && printf '%s\\n' "$apt_path"; }
      install_node
    `, [apt], { APT_CONFIG: '/untrusted.conf', NODE_OPTIONS: '--require=/untrusted.cjs', HOME: temp });
    expect(result.status).toBe(0);
    expect(fs.readFileSync(log, 'utf8')).toBe('update\ninstall -y --no-install-recommends nodejs\n');
  });

  it('does not fall back to an arbitrary package-manager PATH entry', () => {
    const result = shell('trusted_path() { return 1; }; install_node');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('No trusted apt-get');
  });

  it('fails closed if the authenticated package manager cannot install Node', () => {
    const apt = path.join(temp, 'apt-get');
    fs.writeFileSync(apt, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const result = shell(`
      apt_path=$1
      trusted_path() { printf '%s\\n' "$apt_path"; }
      install_node
    `, [apt]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Could not refresh authenticated Node packages');
    expect(result.stdout).toBe('');
  });

  it('requires root at the public entry point', () => {
    if (process.getuid!() === 0) return;
    const result = spawnSync('/bin/bash', [script], { encoding: 'utf8', env: {} });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Run as root from authenticated, protected staging');
  });
});
