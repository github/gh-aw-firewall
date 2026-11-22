import { fs, path, collector, standaloneFixture } from './collector.test-utils';

describe('public enclave credential redaction', () => {
  const f = standaloneFixture();
  const { prepareRun, collectRun, envelope, invocation, write } = f;

  it('redacts credential patterns, preserves approved retained session streams and closes envelope diagnostics', () => {
    prepareRun();
    const value = envelope({
      executorKind: 'agent', payload: 'PRIVATE_PAYLOAD', authorization: 'PRIVATE_CREDENTIAL',
      streams: { stdout: 'captured', stderr: 'captured', session: 'captured' },
      session: {
        status: 'captured', bytes: 256, events: [{ event: 'success', secret: 'PRIVATE_SECRET' }],
        lastEvent: { event: 'success', path: '/PRIVATE_PATH' }, arbitrary: 'PRIVATE',
      },
    });
    const source = invocation(value);
    write(path.join(source, 'stdout.log'), 'github_pat_FAKE_TEST_VALUE ghp_FAKE_TEST_VALUE sk-FAKE_TEST_VALUE\n');
    write(path.join(source, 'stderr.log'), 'Authorization: token PRIVATE_CREDENTIAL\nBearer PRIVATE_TOKEN\n');
    write(path.join(source, 'enclave-session.log'), [
      { event: 'engine-result', exitCode: 0,
        stdout: { raw: 'approved retained engine output', sensitivity: 'raw-debug' },
        stderr: { raw: 'approved retained engine error ghp_FAKE_TEST_VALUE', sensitivity: 'raw-debug', private: '[REDACTED]' },
        secret: '[REDACTED]' },
      { event: 'engine-diagnostics',
        log: { raw: 'approved retained Copilot diagnostics', sensitivity: 'raw-debug', private: '[REDACTED]' },
        private: '[REDACTED]' },
      { event: 'progress', stage: 'engine-completed', runtimeMs: 13, payload: '[REDACTED]' },
      { event: 'retained-extension', message: '[REDACTED]' },
    ].map(event => JSON.stringify(event)).join('\n') + '\n');
    expect(collectRun()).toBe(4);
    for (const name of fs.readdirSync(path.join(f.scope, 'upload'))) {
      expect(fs.readFileSync(path.join(f.scope, 'upload', name), 'utf8')).not.toMatch(/PRIVATE|FAKE_TEST_VALUE/);
    }
    expect(fs.readFileSync(path.join(f.scope, 'upload/enclave-session.log'), 'utf8')).toContain('"exitCode":0');
    expect(fs.readFileSync(path.join(f.scope, 'upload/enclave-session.log'), 'utf8')).toContain('approved retained engine error');
    expect(fs.readFileSync(path.join(f.scope, 'upload/enclave-session.log'), 'utf8')).toContain('approved retained Copilot diagnostics');
    expect(fs.readFileSync(path.join(f.scope, 'upload/enclave-session.log'), 'utf8')).toContain('approved retained engine output');
    expect(fs.readFileSync(path.join(f.scope, 'upload/enclave-session.log'), 'utf8')).toContain('retained-extension');
  });

  it('does not reproject or truncate already-redacted retained session records', () => {
    const record = {
      event: 'engine-diagnostics',
      log: { raw: 'Authorization: [REDACTED]\nretained engine detail\n', sensitivity: 'raw-debug' },
      approvedRetainedField: '[REDACTED]',
    };
    const bytes = Buffer.from(JSON.stringify(record) + '\n');
    expect(collector.redactCredentials(bytes)).toEqual(bytes);
    expect(JSON.parse(collector.redactCredentials(Buffer.from(JSON.stringify({
      ...record, log: { raw: 'Authorization: ******\nretained engine detail\n' },
    }) + '\n')).toString())).toMatchObject({
      event: 'engine-diagnostics', log: { raw: 'Authorization: [REDACTED]\nretained engine detail\n' },
      approvedRetainedField: '[REDACTED]',
    });
  });

  it('recursively redacts JSON strings inside retained session fields', () => {
    const embedded = JSON.stringify({
      message: 'Authorization: [REDACTED]\npublic diagnostic detail',
      nested: JSON.stringify({ authorization: 'PRIVATE_TOKEN', detail: 'keep this detail' }),
    });
    const bytes = Buffer.from(JSON.stringify({ event: 'engine-diagnostics', log: { raw: embedded } }) + '\n');
    const redacted = collector.redactCredentials(bytes).toString('utf8');
    const result = JSON.parse(redacted);
    const raw = JSON.parse(result.log.raw);
    expect(raw.message).toBe('Authorization: [REDACTED]\npublic diagnostic detail');
    expect(JSON.parse(raw.nested)).toEqual({ authorization: '[REDACTED]', detail: 'keep this detail' });
    expect(redacted).not.toContain('PRIVATE_TOKEN');
    let deeplyNested: unknown = 'Authorization: PRIVATE_TOKEN';
    for (let index = 0; index < 70; index++) deeplyNested = { nested: deeplyNested };
    expect(() => collector.redactCredentials(Buffer.from(JSON.stringify({ raw: JSON.stringify(deeplyNested) }) + '\n')))
      .toThrow(/credential-redaction-bound/);
  });

  it('accepts exactly the credential recursion bound and rejects the next level', () => {
    const nested = (depth: number) => {
      let value: unknown = 'ghp_FAKE_TEST_VALUE';
      for (let index = 0; index < depth; index++) value = { nested: value };
      return Buffer.from(JSON.stringify(value));
    };
    expect(collector.redactCredentials(nested(64)).toString()).not.toContain('FAKE_TEST_VALUE');
    expect(() => collector.redactCredentials(nested(65))).toThrow(expect.objectContaining({
      failedCheck: 'credential-redaction-bound', category: 'oversized',
    }));
  });
});
