import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const dockerfilePath = path.resolve(__dirname, '../../containers/agent/Dockerfile');

describe('agent Dockerfile security hardening', () => {
  const npmInstallInstruction = (): string => {
    const dockerfile = fs.readFileSync(dockerfilePath, 'utf-8');
    const instructions = dockerfile
      .replace(/^[ \t]*#.*\r?\n/gm, '')
      .replace(/\\\r?\n/g, ' ')
      .split('\n');
    const instruction = instructions.find(
      line => line.startsWith('RUN ') && line.includes('NPM_TGZ_URL='),
    );
    expect(instruction).toBeDefined();
    return instruction!;
  };

  it('patches vulnerable npm dependencies before committing the installation layer', () => {
    const instruction = npmInstallInstruction();

    for (const dependency of ['undici-6.29.1', 'brace-expansion-5.0.12', 'ip-address-10.7.1']) {
      expect(instruction).toContain(`tar -xzf /tmp/${dependency}.tgz`);
      expect(instruction).toContain(`/${dependency}.tgz" | sha256sum -c -`);
    }
    expect(instruction).toContain('const expected={undici:"6.29.1"');
    expect(instruction).toContain('rm -f /tmp/npm-12.2.1.tgz');
    expect(instruction).toContain('rm -f /tmp/undici-6.29.1.tgz');
  });

  it.each(['agent', 'api-proxy', 'cli-proxy', 'gh-aw-node'])(
    'pins patched Undici with verified bytes throughout the %s npm installation', image => {
      const source = fs.readFileSync(path.resolve(__dirname, `../../containers/${image}/Dockerfile`), 'utf8');
      expect(source).not.toContain('undici-6.28.1');
      expect(source).toContain('https://registry.npmjs.org/undici/-/undici-6.29.1.tgz');
      expect(source).toContain('29c4b8e0b2d86cb8795571c1959012ce057a14ecfd34858335f47c31e770a04f  /tmp/undici-6.29.1.tgz');
      expect(source).toContain('tar -xzf /tmp/undici-6.29.1.tgz -C "$npm_dir/undici" --strip-components=1');
      expect(source).toContain('const expected={undici:"6.29.1"');
    },
  );

  it('retries connection resets within a bounded budget for every npm download', () => {
    const instruction = npmInstallInstruction();
    const npmInstallStart = instruction.indexOf('NPM_TGZ_URL=');
    expect(npmInstallStart).toBeGreaterThan(0);
    const npmDownloads = instruction.slice(npmInstallStart).match(/curl\b[^&;]+/g) ?? [];

    expect(npmDownloads).toHaveLength(4);
    for (const command of npmDownloads) {
      expect(command).toContain('--retry 3');
      expect(command).toContain('--retry-all-errors');
      expect(command).toContain('--retry-max-time 120');
      expect(command).toContain('--connect-timeout 15');
      expect(command).toContain('--max-time 60');
      expect(command).toContain('-fsSL');
    }
  });

  it.each([
    ['download', 35],
    ['checksum', 9],
  ])('fails closed on a %s failure before installing dependencies', (failure, exitCode) => {
    const instruction = npmInstallInstruction();
    const start = instruction.indexOf('npm_dir=');
    expect(start).toBeGreaterThan(0);
    const script = `
set -e
curl() { ${failure === 'download' ? 'return 35' : 'return 0'}; }
sha256sum() { return 9; }
rm() { echo unexpected-remove; }
mkdir() { echo unexpected-create; }
tar() { echo unexpected-extract; }
node() { echo unexpected-execute; }
${instruction.slice(start)}
`;
    const result = spawnSync('bash', ['-c', script], {
      encoding: 'utf-8',
      env: { PATH: process.env.PATH },
      timeout: 5000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(exitCode);
    expect(result.stdout).not.toContain('unexpected-');
  });

  const readHardeningScript = (fixtureDir: string): string => {
    const dockerfile = fs.readFileSync(dockerfilePath, 'utf-8');
    const hardeningBlock = dockerfile.match(
      /for binary in \/usr\/bin\/ping \/usr\/bin\/mtr-packet; do[\s\S]*?done && \\/
    )?.[0];

    expect(hardeningBlock).toBeDefined();
    const pingPath = path.join(fixtureDir, 'ping');
    const mtrPacketPath = path.join(fixtureDir, 'mtr-packet');

    return hardeningBlock!
      .replace(/done && \\\s*$/, 'done')
      .replace(/\/usr\/bin\/ping/g, pingPath)
      .replace(/\/usr\/bin\/mtr-packet/g, mtrPacketPath)
      .split('\n')
      .map((line) => line.trim().replace(/\s*\\$/, ''))
      .join('\n');
  };

  const runHardeningScript = (
    env: NodeJS.ProcessEnv = {}
  ): { stderr: string; status: number | null; stubDir: string } => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-agent-hardening-'));
    fs.writeFileSync(path.join(fixtureDir, 'ping'), '');
    fs.writeFileSync(path.join(fixtureDir, 'mtr-packet'), '');

    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-agent-hardening-stubs-'));
    const script = `
set -e
getcap() {
  echo "$1" >> "${stubDir}/getcap-calls"
  case "$GETCAP_BEHAVIOR" in
    fail) return 7 ;;
    none) return 0 ;;
    capability-then-none)
      if [ "$(wc -l < "${stubDir}/getcap-calls")" -eq 1 ]; then
        echo "$1 cap_net_raw=ep"
      fi
      return 0
      ;;
    always-capability)
      echo "$1 cap_net_raw=ep"
      return 0
      ;;
  esac
}
setcap() {
  echo "$*" >> "${stubDir}/setcap-calls"
  case "$SETCAP_BEHAVIOR" in
    fail) return 8 ;;
    *) return 0 ;;
  esac
}
${readHardeningScript(fixtureDir)}
`;

    const result = spawnSync('bash', ['-c', script], {
      encoding: 'utf-8',
      env: { ...process.env, ...env },
    });

    fs.rmSync(fixtureDir, { recursive: true, force: true });
    return { stderr: result.stderr, status: result.status, stubDir };
  };

  afterEach(() => {
    for (const entry of fs.readdirSync(os.tmpdir())) {
      if (entry.startsWith('awf-agent-hardening-stubs-')) {
        fs.rmSync(path.join(os.tmpdir(), entry), { recursive: true, force: true });
      }
    }
  });

  it('strips and verifies file capabilities on raw-network utilities', () => {
    const script = readHardeningScript('/tmp');

    expect(script).toContain('for binary in /tmp/ping /tmp/mtr-packet; do');
    expect(script).toContain('before_caps="$(getcap "$binary")"');
    expect(script).toContain('setcap -r "$binary"');
    expect(script).toContain('after_caps="$(getcap "$binary")"');
    expect(script).toContain('exit 1');
    expect(script).not.toMatch(/setcap -r "\$binary"[^;\n]*\|\| true/);
  });

  it('fails closed when capability inspection fails', () => {
    const result = runHardeningScript({ GETCAP_BEHAVIOR: 'fail' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ERROR: Failed to inspect file capabilities');
  });

  it('fails closed when capability removal fails', () => {
    const result = runHardeningScript({
      GETCAP_BEHAVIOR: 'always-capability',
      SETCAP_BEHAVIOR: 'fail',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ERROR: Failed to remove file capabilities');
  });

  it('removes capabilities only after inspection proves they are present', () => {
    const result = runHardeningScript({ GETCAP_BEHAVIOR: 'none' });

    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(result.stubDir, 'setcap-calls'))).toBe(false);
  });

  it('passes when capability removal succeeds and verification is clean', () => {
    const result = runHardeningScript({ GETCAP_BEHAVIOR: 'capability-then-none' });

    expect(result.status).toBe(0);
    expect(fs.readFileSync(path.join(result.stubDir, 'setcap-calls'), 'utf-8')).toContain(
      '-r '
    );
  });
});
