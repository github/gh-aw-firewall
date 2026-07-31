import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/* eslint-disable @typescript-eslint/no-require-imports */
const { buildQueryArgs } = require('../../containers/bounded-query/broker/query-runner.js');
/* eslint-enable @typescript-eslint/no-require-imports */

describe('bounded-query Docker isolation', () => {
  const image = `awf-bounded-query-integration:${process.pid}`;
  let root: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-bounded-query-integration-'));
    execFileSync(
      'docker',
      [
        'build',
        '--quiet',
        '--target',
        'query',
        '--tag',
        image,
        path.resolve(__dirname, '../../containers/bounded-query'),
      ],
      { stdio: 'pipe', timeout: 120_000 },
    );
  }, 120_000);

  afterAll(() => {
    execFileSync('docker', ['image', 'rm', '--force', image], { stdio: 'ignore' });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('executes against a writable bounded copy with no network or broker tools', () => {
    const invocationId = 'integration';
    const invocationDir = path.join(root, invocationId);
    const repoDir = path.join(invocationDir, 'repo');
    const outPath = path.join(invocationDir, 'out');
    const scriptPath = path.join(invocationDir, 'script.py');

    fs.mkdirSync(repoDir, { recursive: true, mode: 0o755 });
    fs.chmodSync(root, 0o755);
    fs.chmodSync(invocationDir, 0o755);
    fs.writeFileSync(path.join(repoDir, 'private.txt'), 'assigned repository\n', { mode: 0o644 });
    fs.writeFileSync(outPath, '', { mode: 0o666 });
    fs.chmodSync(outPath, 0o666);
    fs.writeFileSync(
      scriptPath,
      [
        'import json',
        'import shutil',
        'import socket',
        'from pathlib import Path',
        '',
        'repo = Path("/query/repo")',
        '(repo / "mutation.txt").write_text("ephemeral")',
        'network_blocked = False',
        'try:',
        '    socket.create_connection(("1.1.1.1", 53), timeout=0.25)',
        'except OSError:',
        '    network_blocked = True',
        'root_read_only = False',
        'try:',
        '    Path("/rootfs-write").write_text("blocked")',
        'except OSError:',
        '    root_read_only = True',
        'tools_absent = all(shutil.which(tool) is None for tool in ("node", "docker", "apk"))',
        'valid = (repo / "private.txt").read_text() == "assigned repository\\n"',
        'valid = valid and (repo / "mutation.txt").read_text() == "ephemeral"',
        'result = "YES" if valid and network_blocked and root_read_only and tools_absent else "NO"',
        'Path("/query/out").write_text(json.dumps({"result": result}, separators=(",", ":")))',
      ].join('\n'),
      { mode: 0o444 },
    );
    fs.chmodSync(scriptPath, 0o444);

    const args = buildQueryArgs({
      config: {
        hostWorkDir: root,
        queryMountDir: '/query',
        queryScriptPath: '/awf/query-script.py',
        querySeccompPath: path.resolve(__dirname, '../../containers/bounded-query/query-seccomp.json'),
        queryImage: image,
        queryBackend: 'docker',
        memoryLimit: '256m',
        queryUid: 65534,
        queryGid: 65534,
      },
      runId: 'integration-run',
      invocationId,
      containerName: `awf-query-integration-${process.pid}`,
    });

    execFileSync('docker', args, { stdio: 'pipe', timeout: 30_000 });

    expect(fs.readFileSync(outPath, 'utf8')).toBe('{"result":"YES"}');
    expect(fs.existsSync(path.join(repoDir, 'mutation.txt'))).toBe(false);
  }, 60_000);
});
