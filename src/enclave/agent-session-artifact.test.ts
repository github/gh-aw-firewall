import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { preserveInvocationSession } = require('../../containers/enclave/agent-executor/workspace');

describe('enclave agent session artifact preservation', () => {
  let root: string;
  let auditDir: string;
  let sessionLogPath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-enclave-session-artifact-'));
    auditDir = path.join(root, 'audit');
    sessionLogPath = path.join(root, 'session.jsonl');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('preserves redacted sessions in the public audit collection', () => {
    fs.writeFileSync(
      sessionLogPath,
      '{"event":"session","engine":"copilot","sensitivity":"redacted"}\n',
    );

    expect(preserveInvocationSession(sessionLogPath, auditDir, 'redacted')).toBe(true);
    expect(fs.existsSync(path.join(auditDir, 'sessions', 'redacted.jsonl'))).toBe(true);
  });

  it('segregates raw-debug sessions from the public audit collection', () => {
    const privateOutput = 'private repository output';
    fs.writeFileSync(
      sessionLogPath,
      [
        '{"event":"session","engine":"copilot","sensitivity":"raw-debug"}',
        JSON.stringify({
          event: 'engine-result',
          stdout: { sensitivity: 'raw-debug', raw: privateOutput },
        }),
        '',
      ].join('\n'),
    );

    expect(preserveInvocationSession(sessionLogPath, auditDir, 'debug')).toBe(true);
    expect(fs.existsSync(path.join(auditDir, 'sessions', 'debug.jsonl'))).toBe(false);
    expect(
      fs.readFileSync(path.join(auditDir, 'raw-debug-sessions', 'debug.jsonl'), 'utf8'),
    ).toContain(privateOutput);
  });
});
