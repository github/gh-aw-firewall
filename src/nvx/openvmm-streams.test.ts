import { PassThrough, Readable, Writable } from 'stream';
import { createOpenvmmStdoutGate, endStream, pump, writeStream } from './openvmm-streams';

describe('OpenVMM stdout gate', () => {
  it.each([1, 2, 3, 4, 5, 6, 7])('recognizes a prompt split at byte %i', async (split) => {
    const prompt = 'openvmm> ';
    const chunks: Buffer[] = [];
    const source = Readable.from([
      `before${prompt.slice(0, split)}`,
      `${prompt.slice(split)}after`,
      prompt,
    ]);
    const gate = createOpenvmmStdoutGate(source, async (chunk) => { chunks.push(chunk); });
    gate.arm();
    await gate.waitForPrompt(1_000);
    await gate.completed;
    expect(Buffer.concat(chunks).toString()).toBe(`beforeafter${prompt}`);
  });

  it('forwards prompts emitted before arming without satisfying readiness', async () => {
    const chunks: Buffer[] = [];
    const source = new PassThrough();
    let acknowledgeBoot: (() => void) | undefined;
    const bootDelivered = new Promise<void>((resolve) => { acknowledgeBoot = resolve; });
    const gate = createOpenvmmStdoutGate(source, async (chunk) => {
      chunks.push(chunk);
      acknowledgeBoot?.();
    });
    source.write('openvmm> boot\n');
    await bootDelivered;
    gate.arm();
    source.end('openvmm> guest\n');
    await gate.waitForPrompt(1_000);
    await gate.completed;
    expect(Buffer.concat(chunks).toString()).toBe('openvmm> boot\nguest\n');
    expect(() => gate.arm()).toThrow(/already armed/);
  });

  it('flushes a partial prompt on EOF and rejects readiness', async () => {
    const chunks: Buffer[] = [];
    const gate = createOpenvmmStdoutGate(Readable.from(['output open']), async (chunk) => {
      chunks.push(chunk);
    });
    gate.arm();
    await expect(gate.waitForPrompt(1_000)).rejects.toThrow(/closed before the REPL prompt/);
    await gate.completed;
    expect(Buffer.concat(chunks).toString()).toBe('output open');
  });

  it('times out while the pipe remains open', async () => {
    jest.useFakeTimers();
    const source = new PassThrough();
    const gate = createOpenvmmStdoutGate(source, async () => undefined);
    gate.arm();
    try {
      const prompt = expect(gate.waitForPrompt(10)).rejects.toThrow(/Timed out/);
      await jest.advanceTimersByTimeAsync(10);
      await prompt;
    } finally {
      source.end();
      await gate.completed;
      jest.useRealTimers();
    }
  });

  it('propagates destination failures to completion and readiness', async () => {
    const error = new Error('stdout sink failed');
    const gate = createOpenvmmStdoutGate(Readable.from(['openvmm> output']), async () => {
      throw error;
    });
    gate.arm();
    await expect(gate.waitForPrompt(1_000)).rejects.toBe(error);
    await expect(gate.completed).rejects.toBe(error);
  });

  it('requires a stdout pipe', () => {
    expect(() => createOpenvmmStdoutGate(null, async () => undefined)).toThrow(/unavailable/);
  });
});

describe('OpenVMM stream utilities', () => {
  it('pumps buffers and strings in order and permits an absent source', async () => {
    const chunks: Buffer[] = [];
    await pump(Readable.from(['one', Buffer.from('two')]), async (chunk) => {
      expect(Buffer.isBuffer(chunk)).toBe(true);
      await new Promise((resolve) => setImmediate(resolve));
      chunks.push(chunk);
    });
    expect(Buffer.concat(chunks).toString()).toBe('onetwo');
    const destination = jest.fn();
    await pump(null, destination);
    expect(destination).not.toHaveBeenCalled();
  });

  it('propagates pump destination errors', async () => {
    const error = new Error('stderr sink failed');
    await expect(pump(Readable.from(['stderr']), async () => { throw error; })).rejects.toBe(error);
  });

  it.each([writeStream, endStream])('writes all bytes through %p', async (write) => {
    const stream = new PassThrough();
    await write(stream, Buffer.from('bytes'));
    expect(stream.read()).toEqual(Buffer.from('bytes'));
    expect(stream.writableEnded).toBe(write === endStream);
    if (!stream.writableEnded) stream.end();
  });

  it.each([writeStream, endStream])('propagates write errors through %p', async (write) => {
    const error = new Error('pipe write failed');
    const stream = new Writable({
      write: (_chunk, _encoding, callback) => callback(error),
    });
    stream.on('error', () => undefined);
    await expect(write(stream, Buffer.from('bytes'))).rejects.toBe(error);
  });
});
