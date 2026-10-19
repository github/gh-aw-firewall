import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('agent entrypoint Gemini settings staging', () => {
  let root: string;
  const entrypoint = fs.readFileSync(path.join(__dirname, '../containers/agent/entrypoint.sh'), 'utf8');
  const prepare = entrypoint.slice(
    entrypoint.indexOf('prepare_gemini_system_settings() {'),
    entrypoint.indexOf('\nrun_chroot_command() {'),
  );

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-gemini-entrypoint-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function run(setup: string, command = 'prepare_gemini_system_settings') {
    const args = ['-s', '--', root];
    const uid = process.getuid!();
    const gid = process.getgid!();
    return spawnSync(uid === 0 ? '/bin/bash' : 'sudo', uid === 0 ? args : ['-n', '/bin/bash', ...args], {
      encoding: 'utf8',
      input: [
        'set -eu',
        `trap 'chown -hR ${uid}:${gid} "$1"' EXIT`,
        prepare.replace(/\/host/g, root),
        'mkdir -p "$1/etc"',
        'export AWF_GEMINI_SYSTEM_SETTINGS_FALLBACK=1',
        'export GEMINI_CLI_SYSTEM_SETTINGS_PATH=/etc/awf/gemini-cli/settings.json',
        setup,
        command,
      ].join('\n'),
    });
  }

  it('accepts the validated pin on a second container entrypoint invocation', () => {
    const result = run('', [
      'prepare_gemini_system_settings',
      'export AWF_GEMINI_SYSTEM_SETTINGS_FALLBACK=1',
      'prepare_gemini_system_settings',
      'test -z "${AWF_GEMINI_SYSTEM_SETTINGS_FALLBACK:-}"',
      'stat -c "%u:%g:%a" "$1/etc/awf/gemini-cli/settings.json"',
    ].join('\n'));
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('0:0:644');
    expect(JSON.parse(fs.readFileSync(path.join(root, 'etc/awf/gemini-cli/settings.json'), 'utf8')))
      .toEqual({ security: { auth: { selectedType: 'gemini-api-key' } } });
  });

  it.each([
    'ln -s "$1/target" "$1/etc/awf"',
    'mkdir -p "$1/etc/awf"; ln -s "$1/target" "$1/etc/awf/gemini-cli"',
    'mkdir -p "$1/etc/awf/gemini-cli"; ln -s "$1/target/settings.json" "$1/etc/awf/gemini-cli/settings.json"',
  ])('rejects symlink paths without overwriting their targets: %s', (setup) => {
    const result = run(`mkdir "$1/target"; printf unchanged > "$1/target/settings.json"; ${setup}`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Refusing symlink');
    expect(fs.readFileSync(path.join(root, 'target/settings.json'), 'utf8')).toBe('unchanged');
  });

  it.each([
    'chmod 0777 "$1/etc/awf"',
    'chown 1001:1001 "$1/etc/awf/gemini-cli"',
    'chmod 0664 "$1/etc/awf/gemini-cli/settings.json"',
    'chown 1001:1001 "$1/etc/awf/gemini-cli/settings.json"',
    'printf "{}" > "$1/etc/awf/gemini-cli/settings.json"',
    'ln "$1/etc/awf/gemini-cli/settings.json" "$1/linked-settings"',
    'rm "$1/etc/awf/gemini-cli/settings.json"; mkfifo "$1/etc/awf/gemini-cli/settings.json"',
  ])('rejects an unsafe existing pin on retry: %s', (tamper) => {
    const result = run('', [
      'prepare_gemini_system_settings',
      tamper,
      'export AWF_GEMINI_SYSTEM_SETTINGS_FALLBACK=1',
      'prepare_gemini_system_settings',
    ].join('\n'));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Unsafe ownership or permissions|not an AWF auth pin/);
  });
});
