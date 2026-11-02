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
    return spawnSync('/bin/bash', ['-c', 'source "$1"; shift; allow_nodesource=false; ' + body, 'test', script, ...args], {
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
      install=true; allow_nodesource=true
      find_node() { printf '/protected/node\\n'; }
      install_node() { echo unexpected-install >&2; return 1; }
      configure_nodesource() { echo unexpected-vendor-setup >&2; return 1; }
      resolve_node
    `);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('/protected/node');
    expect(result.stderr).toBe('');
  });

  it('tries repeated explicit candidate paths in order before system paths', () => {
    const result = shell(`
      node_paths=(/incompatible/node /protected/node /later/node)
      probe_node() { [[ "$1" == /protected/node ]] && printf '%s\\n' "$1"; }
      find_node
    `);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('/protected/node');
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
    const aptCache = path.join(temp, 'apt-cache');
    const log = path.join(temp, 'apt.log');
    fs.writeFileSync(apt, `#!/bin/bash
[[ -z "\${APT_CONFIG:-}\${NODE_OPTIONS:-}\${HOME:-}" ]] || exit 91
[[ "$DEBIAN_FRONTEND" == noninteractive ]] || exit 92
[[ "$PATH" == /usr/sbin:/usr/bin:/sbin:/bin ]] || exit 93
printf '%s\\n' "$*" >> '${log}'
`, { mode: 0o755 });
    fs.writeFileSync(aptCache, `#!/bin/bash
[[ -z "\${APT_CONFIG:-}\${NODE_OPTIONS:-}\${HOME:-}" ]] || exit 91
[[ "$PATH" == /usr/sbin:/usr/bin:/sbin:/bin ]] || exit 93
printf '  Candidate: 22.0.0-1\\n'
`, { mode: 0o755 });
    const result = shell(`
      apt_path=$1
      apt_cache_path=$2
      trusted_path() {
        case "$1" in
          /usr/bin/apt-get) printf '%s\\n' "$apt_path" ;;
          /usr/bin/apt-cache) printf '%s\\n' "$apt_cache_path" ;;
          *) return 1 ;;
        esac
      }
      install_node
    `, [apt, aptCache], { APT_CONFIG: '/untrusted.conf', NODE_OPTIONS: '--require=/untrusted.cjs', HOME: temp });
    expect(result.status).toBe(0);
    expect(fs.readFileSync(log, 'utf8')).toBe('update\ninstall -y --no-install-recommends nodejs\n');
  });

  it.each(['(none)', '18.19.0-1'])('uses NodeSource when the authenticated APT candidate is %s', initialCandidate => {
    const apt = path.join(temp, 'apt-get');
    const aptCache = path.join(temp, 'apt-cache');
    const aptLog = path.join(temp, 'apt.log');
    const cacheCalls = path.join(temp, 'apt-cache.calls');
    const setupMarker = path.join(temp, 'nodesource.configured');
    fs.writeFileSync(apt, `#!/bin/bash
[[ "$PATH" == /usr/sbin:/usr/bin:/sbin:/bin ]] || exit 93
printf '%s\\n' "$*" >> '${aptLog}'
`, { mode: 0o755 });
    fs.writeFileSync(aptCache, `#!/bin/bash
[[ "$PATH" == /usr/sbin:/usr/bin:/sbin:/bin ]] || exit 93
if [[ ! -e '${cacheCalls}' ]]; then
  /usr/bin/touch '${cacheCalls}'
  printf '  Candidate: ${initialCandidate}\\n'
else
  printf '  Candidate: 22.0.0-1\\n'
fi
`, { mode: 0o755 });
    const result = shell(`
      allow_nodesource=true
      trusted_path() {
        case "$1" in
          /usr/bin/apt-get) printf '%s\\n' "$apt_path" ;;
          /usr/bin/apt-cache) printf '%s\\n' "$apt_cache_path" ;;
          *) return 1 ;;
        esac
      }
      configure_nodesource() { /usr/bin/touch '${setupMarker}'; }
      apt_path=$1
      apt_cache_path=$2
      install_node
    `, [apt, aptCache]);
    expect(result.status).toBe(0);
    expect(fs.existsSync(setupMarker)).toBe(true);
    expect(fs.readFileSync(aptLog, 'utf8')).toBe('update\nupdate\ninstall -y --no-install-recommends nodejs\n');
  });

  it('does not install an incompatible APT candidate without NodeSource authorization', () => {
    const apt = path.join(temp, 'apt-get');
    const aptCache = path.join(temp, 'apt-cache');
    const log = path.join(temp, 'apt.log');
    fs.writeFileSync(apt, `#!/bin/bash\nprintf '%s\\n' "$*" >> '${log}'\n`, { mode: 0o755 });
    fs.writeFileSync(aptCache, '#!/bin/bash\nprintf "  Candidate: (none)\\n"\n', { mode: 0o755 });
    const result = shell(`
      trusted_path() {
        case "$1" in
          /usr/bin/apt-get) printf '%s\\n' "$apt_path" ;;
          /usr/bin/apt-cache) printf '%s\\n' "$apt_cache_path" ;;
          *) return 1 ;;
        esac
      }
      apt_path=$1; apt_cache_path=$2
      install_node
    `, [apt, aptCache]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('No compatible Node >=20.19 APT candidate');
    expect(fs.readFileSync(log, 'utf8')).toBe('update\n');
  });

  it('does not fall back to an arbitrary package-manager PATH entry', () => {
    const result = shell('trusted_path() { return 1; }; install_node');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('No trusted apt-get');
  });

  it('returns the runtime made available by package provisioning', () => {
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

  it('does not configure NodeSource without explicit permission', () => {
    const result = shell(`
      install=true
      find_node() { return 1; }
      install_node() { :; }
      configure_nodesource() { echo unexpected-vendor-setup >&2; }
      resolve_node
    `);
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain('unexpected-vendor-setup');
  });

  it('does not execute a NodeSource setup script after a checksum mismatch', () => {
    const curl = path.join(temp, 'curl');
    const marker = path.join(temp, 'setup-ran');
    fs.writeFileSync(curl, `#!/bin/bash
[[ -z "\${CURL_HOME:-}\${NODE_OPTIONS:-}\${HOME:-}" ]] || exit 91
[[ "$1" == -q && "$*" == *"--proto =https --proto-redir =https"* ]] || exit 92
[[ "\${!#}" == https://deb.nodesource.com/setup_lts.x ]] || exit 93
while [[ "$1" != --output ]]; do shift; done
cat > "$2" <<'SETUP'
touch '${marker}'
SETUP
`, { mode: 0o755 });
    const result = shell('run_nodesource_setup "$1" "$2"', [curl, temp], {
      CURL_HOME: temp, NODE_OPTIONS: '--require=/untrusted.cjs', HOME: temp,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('NodeSource setup checksum mismatch');
    expect(fs.existsSync(marker)).toBe(false);
    expect(result.stdout).toBe('');
  });

  it('does not run vendor setup if download authentication fails', () => {
    const curl = path.join(temp, 'curl');
    fs.writeFileSync(curl, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const result = shell('run_nodesource_setup "$1" "$2"', [curl, temp]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Could not authenticate/download standard NodeSource');
    expect(fs.existsSync(path.join(temp, 'setup.sh'))).toBe(false);
  });

  it('refuses vendor setup unless both system curl and its staging ancestor are trusted', () => {
    const result = shell(`
      trusted_path() { [[ "$1" == /usr/bin/curl ]] && printf '%s\\n' "$1"; }
      configure_nodesource
    `);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('NodeSource setup requires a protected /var/lib');
    expect(result.stdout).toBe('');
  });

  it('restores a readable APT umask without widening the private staging directory', () => {
    const result = shell(`
      trusted_path() {
        case "$1" in
          /usr/bin/curl) printf '%s\\n' "$1" ;;
          /var/lib) printf '%s\\n' "$test_state_root" ;;
          *) return 1 ;;
        esac
      }
      run_nodesource_setup() {
        [[ "$(umask)" == 0022 ]] || return 1
        [[ "$(/usr/bin/stat -c '%a' "$2")" == 700 ]] || return 1
        : > "$2/sources.list"
        [[ "$(/usr/bin/stat -c '%a' "$2/sources.list")" == 644 ]]
      }
      test_state_root=$1
      configure_nodesource
    `, [temp]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it.each([
    [['--node-path'], 'Missing value'],
    [['--tool-cache'], 'Missing value'],
    [['--node-path', 'node'], 'requires an absolute path'],
    [['--tool-cache', 'relative'], 'requires an absolute path'],
    [['--unknown'], 'Unknown option'],
    [['--allow-nodesource'], 'requires --install'],
  ])('validates public CLI arguments %j before requiring root', (args, message) => {
    const result = shell('main "$@"', args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  });

  it('keeps APT update failures fatal even when NodeSource is authorized', () => {
    const apt = path.join(temp, 'apt-get');
    const setupMarker = path.join(temp, 'nodesource.configured');
    fs.writeFileSync(apt, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const result = shell(`
      allow_nodesource=true
      apt_path=$1
      trusted_path() { printf '%s\\n' "$apt_path"; }
      configure_nodesource() { /usr/bin/touch '${setupMarker}'; }
      install_node
    `, [apt]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Could not refresh authenticated Node packages');
    expect(result.stdout).toBe('');
    expect(fs.existsSync(setupMarker)).toBe(false);
  });

  it('requires root at the public entry point', () => {
    if (process.getuid!() === 0) return;
    const result = spawnSync('/bin/bash', [script], { encoding: 'utf8', env: {} });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Run as root from authenticated, protected staging');
  });
});
