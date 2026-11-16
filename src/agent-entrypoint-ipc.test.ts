import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';

describe('agent entrypoint host runtime IPC check', () => {
  const entrypoint = path.resolve(__dirname, '../containers/agent/entrypoint.sh');
  let directory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-ipc-'));
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function check(prefix = '') {
    return spawnSync('/bin/bash', ['-c', [
      'source "$1"',
      prefix,
      'check_runtime_ipc_paths "$TMPDIR"',
    ].join('\n'), 'ipc-test', entrypoint], {
      encoding: 'utf8',
      env: { ...process.env, TMPDIR: directory, HOME: directory, RUNNER_TEMP: directory },
    });
  }

  it('accepts a clean temporary directory', () => {
    expect(check().status).toBe(0);
  });

  it.each(['clr-debug-pipe-123-456-in', 'clr-debug-pipe-123-456-out'])(
    'rejects a host debugger FIFO %s without unlinking it',
    (name) => {
      const fifo = path.join(directory, name);
      expect(spawnSync('mkfifo', ['-m', '600', fifo]).status).toBe(0);
      const result = check();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('CoreCLR debug/diagnostic IPC is visible');
      expect(fs.lstatSync(fifo).isFIFO()).toBe(true);
    },
  );

  it('rejects a diagnostic socket in a nested handoff directory', async () => {
    const nested = path.join(directory, 'handoff');
    fs.mkdirSync(nested);
    const socket = path.join(nested, 'dotnet-diagnostic-123-456-socket');
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      const result = check();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('CoreCLR debug/diagnostic IPC is visible');
      expect(fs.lstatSync(socket).isSocket()).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('fails closed if directory inspection fails', () => {
    const result = check('find() { return 1; }');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Cannot inspect shared paths');
  });

  it('checks both temporary roots and both views of configured host paths', () => {
    const result = spawnSync('/bin/bash', ['-c', [
      'source "$1"',
      'check_runtime_ipc_paths() { printf "%s\\n" "$@"; }',
      'check_host_runtime_ipc',
    ].join('\n'), 'ipc-test', entrypoint], {
      encoding: 'utf8',
      env: { ...process.env, TMPDIR: '/custom/temp', HOME: '/custom/home', RUNNER_TEMP: '/runner/temp' },
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual([
      '/tmp', '/host/tmp', '/custom/temp', '/host/custom/temp',
      '/custom/home', '/host/custom/home', '/runner/temp', '/host/runner/temp',
    ]);
  });

  it('runs the check before both command launch paths', () => {
    const script = fs.readFileSync(entrypoint, 'utf8');
    for (const name of ['run_chroot_command', 'run_non_chroot_command']) {
      const body = script.split(`${name}() {`)[1].split('\n}\n')[0];
      expect(body).toContain('check_host_runtime_ipc || exit 1');
      expect(body.indexOf('check_host_runtime_ipc || exit 1'))
        .toBeLessThan(body.lastIndexOf('run_command_with_stdout'));
    }
  });
});
