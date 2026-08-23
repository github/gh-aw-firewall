import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const dockerfilePath = path.resolve(__dirname, '../../containers/agent/Dockerfile');

describe('agent Dockerfile security hardening', () => {
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
