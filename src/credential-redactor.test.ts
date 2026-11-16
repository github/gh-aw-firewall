import { CredentialRedactingStream, redactCredentials } from './credential-redactor';

function runStream(chunks: string[]): Promise<{ output: string; detections: number }> {
  return new Promise((resolve, reject) => {
    let output = '';
    let detections = 0;
    const stream = new CredentialRedactingStream(() => {
      detections += 1;
    });
    stream.on('data', (chunk) => {
      output += chunk.toString();
    });
    stream.on('error', reject);
    stream.on('end', () => resolve({ output, detections }));
    for (const chunk of chunks) stream.write(chunk);
    stream.end();
  });
}

describe('credential redaction', () => {
  it('redacts GitHub tokens and runner JWTs', () => {
    const githubToken = `ghs_${'a'.repeat(36)}`;
    const jwt = `eyJ${'a'.repeat(20)}.${'b'.repeat(30)}.${'c'.repeat(30)}`;
    const result = redactCredentials(`tokens: ${githubToken} ${jwt}`);

    expect(result.detected).toBe(true);
    expect(result.output).not.toContain(githubToken);
    expect(result.output).not.toContain(jwt);
    expect(result.output.length).toBe(`tokens: ${githubToken} ${jwt}`.length);
  });

  it('detects tokens split across stream chunks', async () => {
    const token = `github_pat_${'a'.repeat(40)}`;
    const result = await runStream([
      `before ${token.slice(0, 18)}`,
      `${token.slice(18)} after\n`,
    ]);

    expect(result.detections).toBe(1);
    expect(result.output).not.toContain(token);
    expect(result.output).toContain('[REDACTED_CREDENTIAL]');
  });

  it('passes ordinary output through unchanged', async () => {
    const result = await runStream(['hello ', 'world\n']);

    expect(result).toEqual({ output: 'hello world\n', detections: 0 });
  });

  it('passes non-UTF-8 output through without corruption', async () => {
    const input = Buffer.from([0x00, 0xff, 0x41]);
    const chunks: Buffer[] = [];
    const stream = new CredentialRedactingStream(() => {
      throw new Error('unexpected detection');
    });
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stream.end(input);
    await new Promise((resolve) => stream.on('end', resolve));

    expect(Buffer.concat(chunks)).toEqual(input);
  });
});
