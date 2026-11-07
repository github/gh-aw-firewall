import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { execFileSync } from 'child_process';
import { projectEnclaveSessionDiagnostics } from '../cloud-hypervisor/enclave-session-diagnostics';

jest.mock('fs', () => ({ ...jest.requireActual('fs'), chownSync: jest.fn() }));

/* eslint-disable @typescript-eslint/no-require-imports */
const {
  preserveInvocationSession, createInvocationWorkspace,
} = require('../../containers/enclave/agent-executor/workspace');
/* eslint-enable @typescript-eslint/no-require-imports */

describe('enclave agent session artifact preservation', () => {
  let root: string;
  let auditDir: string;
  let sessionLogPath: string;

  beforeEach(() => {
    root = path.join(process.cwd(), `.enclave-session-artifact-${randomBytes(8).toString('hex')}`);
    fs.mkdirSync(root, { mode: 0o700 });
    auditDir = path.join(root, 'audit');
    sessionLogPath = path.join(root, 'session.jsonl');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps the writable transcript owned by the trusted supervisor', () => {
    const workspace = createInvocationWorkspace({
      config: { workDir: root, enclaveUid: 65534, enclaveGid: 65534 },
      invocationId: 'a'.repeat(32), task: 'task', schema: { type: 'boolean' },
    });
    const info = fs.statSync(workspace.sessionLogPath);
    expect(info.uid).toBe(process.getuid?.() ?? 0);
    expect(info.uid).not.toBe(65534);
    expect(info.mode & 0o777).toBe(0o644);
  });

  it('refuses to share transcript ownership with the enclave user', () => {
    expect(() => createInvocationWorkspace({
      config: {
        workDir: root,
        enclaveUid: process.getuid?.() ?? 0,
        enclaveGid: process.getgid?.() ?? 0,
      },
      invocationId: 'b'.repeat(32), task: 'task', schema: { type: 'boolean' },
    })).toThrow(/separate supervisor identity/);
  });

  it('preserves only projected metadata in the public audit collection', () => {
    fs.writeFileSync(
      sessionLogPath,
      '{"event":"progress","stage":"engine-started","sensitivity":"redacted"}\n',
    );

    expect(preserveInvocationSession(sessionLogPath, auditDir, 'redacted')).toBe(true);
    expect(fs.existsSync(path.join(auditDir, 'sessions', 'redacted.jsonl'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(auditDir, 'sessions', 'redacted.jsonl'), 'utf8')))
      .toEqual(projectEnclaveSessionDiagnostics(fs.readFileSync(sessionLogPath)));
  });

  it.each([
    '{"event":"session","sensitivity":"redacted","private":"private seed sentinel"}\n',
    '{"event":"success","private":"private seed sentinel"}\n',
    '{"event":"failure","category":"result-schema","private":"private seed sentinel"}\n',
    'private seed sentinel\n',
  ])('never trusts workload-controlled transcript classification: %s', transcript => {
    fs.writeFileSync(sessionLogPath, transcript);
    expect(preserveInvocationSession(sessionLogPath, auditDir, 'forged')).toBe(true);
    expect(fs.existsSync(path.join(auditDir, 'raw-debug-sessions'))).toBe(false);
    const contents = fs.readFileSync(path.join(auditDir, 'sessions', 'forged.jsonl'), 'utf8');
    expect(contents).not.toContain('private seed sentinel');
    expect(JSON.parse(contents)).toEqual(projectEnclaveSessionDiagnostics(Buffer.from(transcript)));
    expect(fs.statSync(path.join(auditDir, 'sessions')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(auditDir, 'sessions', 'forged.jsonl')).mode & 0o777)
      .toBe(0o600);
  });

  it.each(['raw-debug', 'redacted'])('ignores guest-controlled %s labels and strips private payloads', sensitivity => {
    const privateOutput = 'private repository output';
    fs.writeFileSync(
      sessionLogPath,
      [
        JSON.stringify({ event: 'session', engine: 'copilot', sensitivity, privateOutput }),
        JSON.stringify({
          event: 'engine-result',
          exitCode: 1,
          stdout: { sensitivity: 'raw-debug', raw: privateOutput },
          stderr: { bytes: privateOutput.length, sha256: privateOutput },
          [privateOutput]: privateOutput,
        }),
        JSON.stringify({ event: 'progress', stage: privateOutput }),
        JSON.stringify({ event: 'failure', category: 'engine-failed', message: privateOutput }),
        privateOutput,
        'null',
        '[]',
        '',
      ].join('\n'),
    );

    expect(preserveInvocationSession(sessionLogPath, auditDir, 'debug')).toBe(true);
    const destination = path.join(auditDir, 'sessions', 'debug.jsonl');
    expect(fs.existsSync(path.join(auditDir, 'raw-debug-sessions'))).toBe(false);
    const contents = fs.readFileSync(destination, 'utf8');
    expect(contents).not.toContain(privateOutput);
    expect(contents).not.toContain('sha256');
    expect(JSON.parse(contents)).toEqual(projectEnclaveSessionDiagnostics(fs.readFileSync(sessionLogPath)));
    expect(JSON.parse(contents).events).toEqual([
      { event: 'engine-result', exitCode: 1 },
      { event: 'failure', category: 'engine-failed' },
    ]);
    expect(fs.statSync(destination).mode & 0o777).toBe(0o600);
  });

  it.each(['symlink', 'fifo', 'oversized'])('does not export %s sources', kind => {
    if (kind === 'symlink') {
      const target = path.join(root, 'private');
      fs.writeFileSync(target, 'private repository output');
      fs.symlinkSync(target, sessionLogPath);
    } else if (kind === 'oversized') {
      fs.writeFileSync(sessionLogPath, Buffer.alloc(1024 * 1024 + 1));
    } else {
      execFileSync('mkfifo', [sessionLogPath]);
    }
    expect(preserveInvocationSession(sessionLogPath, auditDir, 'unsafe')).toBe(false);
    expect(fs.existsSync(auditDir)).toBe(false);
  });

  it('exports invalid UTF-8 as closed failure metadata', () => {
    fs.writeFileSync(sessionLogPath, Buffer.from([0xff]));
    expect(preserveInvocationSession(sessionLogPath, auditDir, 'invalid')).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(auditDir, 'sessions', 'invalid.jsonl'), 'utf8')))
      .toEqual({ status: 'invalid', bytes: 1 });
  });
});
