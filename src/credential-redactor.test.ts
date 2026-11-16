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

  it('scans credentials in non-UTF-8 output while preserving unrelated bytes', async () => {
    const token = `ghp_${'a'.repeat(24)}`;
    const chunksIn = [
      Buffer.from([0x00, 0xff]),
      Buffer.from(token.slice(0, 9)),
      Buffer.from(token.slice(9)),
      Buffer.from([0xe2]),
      Buffer.from([0x82]),
      Buffer.from([0xac, 0xfe, 0x41]),
    ];
    const input = Buffer.concat(chunksIn);
    const chunks: Buffer[] = [];
    let detections = 0;
    const stream = new CredentialRedactingStream(() => {
      detections += 1;
    });
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    for (const chunk of chunksIn) stream.write(chunk);
    stream.end();
    await new Promise((resolve) => stream.on('end', resolve));

    const output = Buffer.concat(chunks);
    expect(detections).toBe(1);
    expect(output.length).toBe(input.length);
    expect(output.subarray(0, 2)).toEqual(Buffer.from([0x00, 0xff]));
    expect(output.subarray(-5)).toEqual(Buffer.from([0xe2, 0x82, 0xac, 0xfe, 0x41]));
    expect(output.toString('latin1')).not.toContain(token);
    expect(output.toString('latin1')).toContain('[REDACTED_CREDENTIAL]');
  });

  it('retains a credential that crosses the bounded emission boundary', async () => {
    const token = `ghp_${'b'.repeat(40)}`;
    const prefix = Buffer.from(`${'x'.repeat(24_569)} `);
    const tokenBytes = Buffer.from(token);
    const suffixLength = 32_769 - prefix.length - tokenBytes.length;
    const firstChunk = Buffer.concat([
      prefix,
      tokenBytes,
      Buffer.from(`!${'y'.repeat(suffixLength - 1)}`),
    ]);
    const chunks: Buffer[] = [];
    let detections = 0;
    const stream = new CredentialRedactingStream(() => {
      detections += 1;
    });
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stream.write(firstChunk);
    stream.end(Buffer.from('\n'));
    await new Promise((resolve) => stream.on('end', resolve));

    const output = Buffer.concat(chunks);
    expect(detections).toBe(1);
    expect(output.length).toBe(firstChunk.length + 1);
    expect(output.toString('latin1')).not.toContain(token);
  });

  it('does not flag credential placeholders or assignment examples', () => {
    const result = redactCredentials(
      'GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}\nexport GITHUB_TOKEN=<your-token>',
    );

    expect(result).toEqual({
      output: 'GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}\nexport GITHUB_TOKEN=<your-token>',
      detected: false,
    });
  });
});
