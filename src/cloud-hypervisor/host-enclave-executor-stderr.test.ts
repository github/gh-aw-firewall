import { HostEnclaveStderr } from './host-enclave-executor-stderr';

describe('HostEnclaveStderr', () => {
  const limit = 16 * 1024;

  it('joins arbitrary byte chunks and ignores the unterminated tail, including at stream end', () => {
    const stream = new HostEnclaveStderr();
    const text = Buffer.from('first\n☃\r\n\nunfinished');
    for (const byte of text) stream.write(Buffer.from([byte]));
    stream.end();
    expect(stream.captured()).toEqual(Buffer.from('first\n☃\r\n\n'));
  });

  it('retains a line exactly at the byte limit including its newline', () => {
    const stream = new HostEnclaveStderr();
    stream.write('older\n');
    stream.write('a'.repeat(limit - 1));
    expect(stream.captured().toString()).toBe('older\n');
    stream.write('\n');
    expect(stream.captured()).toEqual(Buffer.from(`${'a'.repeat(limit - 1)}\n`));
  });

  it('evicts whole oldest records rather than truncating a line', () => {
    const stream = new HostEnclaveStderr();
    stream.write(`first\n${'a'.repeat(limit - 8)}\nlast\n`);
    expect(stream.captured().toString()).toBe(`${'a'.repeat(limit - 8)}\nlast\n`);
    expect(stream.captured().length).toBeLessThanOrEqual(limit);
  });

  it.each([false, true])('discards an oversized line and resumes after its newline (chunked=%s)', (chunked) => {
    const stream = new HostEnclaveStderr();
    stream.write('before\n');
    if (chunked) {
      stream.write('a'.repeat(limit - 1));
      stream.write('b');
      stream.write('discarded');
      stream.write('\nafter\n');
    } else {
      stream.write(`${'a'.repeat(limit)}\nafter\n`);
    }
    expect(stream.captured().toString()).toBe('before\nafter\n');
  });

  it('bounds retained UTF-8 bytes, not character count', () => {
    const stream = new HostEnclaveStderr();
    stream.write(`${'☃'.repeat(Math.ceil(limit / 3))}\nok\n`);
    expect(stream.captured().toString()).toBe('ok\n');
  });
});
