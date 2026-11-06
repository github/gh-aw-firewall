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

  it('keeps even redacted sessions out of the public audit collection', () => {
    fs.writeFileSync(
      sessionLogPath,
      '{"event":"session","engine":"copilot","sensitivity":"redacted"}\n',
    );

    expect(preserveInvocationSession(sessionLogPath, auditDir, 'redacted')).toBe(true);
    expect(fs.existsSync(path.join(auditDir, 'sessions'))).toBe(false);
    expect(fs.readFileSync(path.join(auditDir, 'raw-debug-sessions', 'redacted.jsonl'), 'utf8'))
      .toContain('"sensitivity":"redacted"');
  });

  it.each([
    '{"event":"session","sensitivity":"redacted","private":"private seed sentinel"}\n',
    '{"event":"success","private":"private seed sentinel"}\n',
    '{"event":"failure","category":"result-schema","private":"private seed sentinel"}\n',
    'private seed sentinel\n',
  ])('never trusts workload-controlled transcript classification: %s', transcript => {
    fs.writeFileSync(sessionLogPath, transcript);
    expect(preserveInvocationSession(sessionLogPath, auditDir, 'forged')).toBe(true);
    expect(fs.existsSync(path.join(auditDir, 'sessions'))).toBe(false);
    expect(fs.readFileSync(path.join(auditDir, 'raw-debug-sessions', 'forged.jsonl'), 'utf8'))
      .toBe(transcript);
    expect(fs.statSync(path.join(auditDir, 'raw-debug-sessions')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(auditDir, 'raw-debug-sessions', 'forged.jsonl')).mode & 0o777)
      .toBe(0o600);
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
