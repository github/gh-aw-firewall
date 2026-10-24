import { isSafeCopilotAuthLogFields, projectCopilotAuthLogFields } from './proxy-auth-diagnostics';
import { captureEnclaveProxyContainerLog, preservePublicEnclaveProxyDiagnostics } from './proxy-debug-retention';
import * as fs from 'fs';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const collector = require('../../scripts/ci/collect-enclave-smoke-debug.cjs');

const fixture = {
  credential_source: 'github_token', credential_kind: 'fine_grained_pat', credential_shape: 'clean',
  target_source: 'explicit', server_kind: 'missing', base_path: 'none',
  integration_source: 'default', authorization_match: 'yes', integration_match: 'no',
  target: 'standard', target_match: 'yes', method: 'post', endpoint: 'chat_completions',
  authorization: 'bearer', integration: 'cli', error_class: 'invalid_credential',
  body_capture: 'complete', challenge: 'invalid_token',
};

describe('public Copilot authentication projection', () => {
  it.each(Object.keys(fixture))('does not publish arbitrary values in %s', name => {
    const fields = projectCopilotAuthLogFields({ ...fixture, [name]: 'PRIVATE_TOKEN' });
    expect(fields).toContain(`${name}=unknown`);
    expect(fields).not.toContain('PRIVATE_TOKEN');
    expect(isSafeCopilotAuthLogFields(fields)).toBe(true);
  });

  it('accepts only the exact canonical finite field set, including explicit unknowns', () => {
    const fields = projectCopilotAuthLogFields(fixture);
    expect(isSafeCopilotAuthLogFields(fields)).toBe(true);
    for (const unsafe of [
      `${fields} credential_source=github_token`, `${fields} secret=PRIVATE_TOKEN`,
      fields.replace('authorization=bearer', 'authorization=PRIVATE_TOKEN'),
      fields.replace('target=standard ', ''), fields.replace('target=standard', 'target=standard\nPRIVATE'),
      '', 'x'.repeat(1025),
    ]) {
      expect(isSafeCopilotAuthLogFields(unsafe)).toBe(false);
    }
  });

  it('retains auth fields through protected production retention and both upload collectors', async () => {
    const root = fs.mkdtempSync(path.join(process.cwd(), '.auth-projection-test-'));
    try {
      const log = await captureEnclaveProxyContainerLog(async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
          level: 'warn', event: 'copilot_auth_diagnostic', status: 401, ...fixture,
          Authorization: 'PRIVATE_CREDENTIAL', response_body: 'PRIVATE_BODY', targetHost: 'PRIVATE_HOST',
        }) + '\n',
        stderr: '',
      }));
      expect(log).toContain(projectCopilotAuthLogFields(fixture));
      expect(log).not.toMatch(/PRIVATE|targetHost|Authorization|response_body/);
      const runId = 'a'.repeat(32);
      const journalDir = path.join(root, 'journal');
      await preservePublicEnclaveProxyDiagnostics({ runId, journalDir },
        { scope: 'run-cumulative', status: 'captured', records: 1, local: {}, upstream: { '401': 1 } },
        [{ schemaVersion: 1, origin: 'upstream', status: 401 }], log);
      const directory = path.join(journalDir, 'diagnostics');
      const [file] = fs.readdirSync(directory);
      expect(fs.statSync(path.join(directory, file)).mode & 0o777).toBe(0o600);
      const retained = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8')).containerLog;
      expect(collector.projectProxyContainerLog(Buffer.from(retained)).toString()).toBe(log);
      expect(Buffer.byteLength(log)).toBeLessThan(1024);
      expect(() => collector.projectProxyContainerLog(Buffer.from(
        log.replace('target=standard', 'target=PRIVATE_HOST'),
      ))).toThrow(/Unsafe/);
      await expect(preservePublicEnclaveProxyDiagnostics({ runId, journalDir },
        { scope: 'run-cumulative', status: 'empty' }, [],
        log.replace('target=standard', 'target=PRIVATE_HOST'))).rejects.toThrow(/Unsafe/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not accept extra auth fields on an ordinary event', () => {
    expect(() => collector.projectProxyContainerLog(Buffer.from(
      'source=stdout level=warn event=upstream_auth_error status=401 target=standard\n' +
      'capture_status=captured dropped=0\n',
    ))).toThrow(/Unsafe/);
  });
});
