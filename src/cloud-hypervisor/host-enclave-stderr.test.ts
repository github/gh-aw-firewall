import { createHostEnclaveStderrCapture } from './host-enclave-stderr';

describe('host enclave stderr capture', () => {
  it('retains complete lines across writes and omits an unfinished line', () => {
    const capture = createHostEnclaveStderrCapture();
    capture.stream.write('first\nsec');
    capture.stream.write(Buffer.from('ond\nunfinished'));
    expect(capture.read().toString()).toBe('first\nsecond\n');
    capture.stream.end();
    expect(capture.read().toString()).toBe('first\nsecond\n');
  });

  it('retains only the newest complete lines within the byte limit', () => {
    const capture = createHostEnclaveStderrCapture();
    const line = `${'a'.repeat(8191)}\n`;
    capture.stream.write(line);
    capture.stream.write(line);
    expect(capture.read().length).toBe(16 * 1024);
    capture.stream.write('last\n');
    expect(capture.read().toString()).toBe(`${line}last\n`);
  });

  it('discards an oversized line across chunks without retaining its suffix', () => {
    const capture = createHostEnclaveStderrCapture();
    capture.stream.write('before\n');
    capture.stream.write('x'.repeat(16 * 1024 - 1));
    capture.stream.write('x');
    capture.stream.write('discarded suffix\nvalid\n');
    capture.stream.write(`${'x'.repeat(16 * 1024)}\nafter\n`);
    expect(capture.read().toString()).toBe('before\nvalid\nafter\n');
  });

  it('counts multibyte lines by bytes rather than characters', () => {
    const capture = createHostEnclaveStderrCapture();
    capture.stream.write(`${'é'.repeat(8192)}\nvalid\n`);
    expect(capture.read().toString()).toBe('valid\n');
  });
});
