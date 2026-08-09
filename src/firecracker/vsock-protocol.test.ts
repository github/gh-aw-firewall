import {
  FIRECRACKER_GUEST_PROTOCOL_VERSION,
  FIRECRACKER_MAX_FRAME_BYTES,
  FIRECRACKER_MAX_STREAM_CHUNK_BYTES,
  FirecrackerFrameDecoder,
  FirecrackerProtocolError,
  encodeFirecrackerFrame,
  validateFirecrackerFrame,
  type FirecrackerGuestFrame,
} from './vsock-protocol';

const ready: FirecrackerGuestFrame = {
  version: FIRECRACKER_GUEST_PROTOCOL_VERSION,
  type: 'ready',
  requestId: 'control',
  capabilities: { stdin: true, tty: false, resize: false },
};

describe('Firecracker guest vsock protocol', () => {
  it('frames and incrementally decodes typed messages', () => {
    const encoded = encodeFirecrackerFrame(ready);
    const decoder = new FirecrackerFrameDecoder();
    expect(decoder.push(encoded.subarray(0, 2))).toEqual([]);
    expect(decoder.push(encoded.subarray(2, 7))).toEqual([]);
    expect(decoder.push(encoded.subarray(7))).toEqual([ready]);
    expect(() => decoder.finish()).not.toThrow();
  });

  it('decodes multiple frames and rejects incomplete terminal data', () => {
    const decoder = new FirecrackerFrameDecoder();
    expect(decoder.push(Buffer.concat([
      encodeFirecrackerFrame(ready),
      encodeFirecrackerFrame({ ...ready, requestId: 'second' }),
    ]))).toHaveLength(2);
    decoder.push(Buffer.from([0, 0]));
    expect(() => decoder.finish()).toThrow(/incomplete frame/);
  });

  it('rejects oversized, empty, malformed, and unknown frames', () => {
    const decoder = new FirecrackerFrameDecoder();
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32BE(FIRECRACKER_MAX_FRAME_BYTES + 1);
    expect(() => decoder.push(oversized)).toThrow(/Invalid.*length/);

    expect(() => validateFirecrackerFrame({
      ...ready,
      version: 2,
    })).toThrow(new FirecrackerProtocolError(
      'protocol_version_mismatch',
      'Unsupported Firecracker guest protocol version 2; expected 1',
    ));
    expect(() => validateFirecrackerFrame({
      ...ready,
      unexpected: true,
    })).toThrow(/Unexpected frame property/);
  });

  it('validates execute schemas, identifiers, and bounded environment data', () => {
    expect(() => validateFirecrackerFrame({
      version: 1,
      type: 'execute',
      requestId: '../escape',
      argv: ['sh'],
      env: {},
      cwd: '/workspace',
      uid: 1000,
      gid: 1000,
      tty: false,
    })).toThrow(/requestId/);
    expect(() => validateFirecrackerFrame({
      version: 1,
      type: 'execute',
      requestId: 'run',
      argv: [],
      env: {},
      cwd: '/workspace',
      uid: 1000,
      gid: 1000,
      tty: false,
    })).toThrow(/argv/);
    expect(() => validateFirecrackerFrame({
      version: 1,
      type: 'execute',
      requestId: 'run',
      argv: ['sh'],
      env: { 'BAD-NAME': 'value' },
      cwd: '/workspace',
      uid: 1000,
      gid: 1000,
      tty: false,
    })).toThrow(/environment variable/);
  });

  it('enforces decoded stream chunk limits and exact result semantics', () => {
    expect(() => validateFirecrackerFrame({
      version: 1,
      type: 'stdout',
      requestId: 'run',
      data: Buffer.alloc(FIRECRACKER_MAX_STREAM_CHUNK_BYTES + 1).toString('base64'),
    })).toThrow(/decoded stream data exceeds/);
    expect(() => validateFirecrackerFrame({
      version: 1,
      type: 'result',
      requestId: 'run',
      exitCode: 0,
      signal: 'SIGTERM',
      timedOut: false,
    })).toThrow(/exactly one/);
  });

  it('validates every host and guest frame schema boundary', () => {
    const validFrames: FirecrackerGuestFrame[] = [
      {
        version: 1,
        type: 'execute',
        requestId: 'run',
        argv: ['sh'],
        env: { EMPTY: '' },
        cwd: '/workspace',
        uid: 1000,
        gid: 1000,
        tty: false,
        timeoutMs: 1,
      },
      {
        version: 1,
        type: 'stdin',
        requestId: 'run',
        data: Buffer.from('input').toString('base64'),
        eof: true,
      },
      { version: 1, type: 'resize', requestId: 'run', columns: 80, rows: 24 },
      { version: 1, type: 'cancel', requestId: 'run', reason: 'test' },
      {
        version: 1,
        type: 'result',
        requestId: 'run',
        exitCode: null,
        signal: 'SIGTERM',
        timedOut: false,
      },
      {
        version: 1,
        type: 'error',
        requestId: 'run',
        code: 'protocol_version_mismatch',
        message: 'wrong version',
        expectedVersion: 1,
      },
      { version: 1, type: 'shutdown', requestId: 'shutdown' },
      { version: 1, type: 'shutting_down', requestId: 'shutdown' },
    ];
    for (const frame of validFrames) {
      expect(() => validateFirecrackerFrame(frame)).not.toThrow();
    }

    const invalidFrames: unknown[] = [
      null,
      [],
      { ...ready, capabilities: { stdin: true, tty: false, resize: 'no' } },
      {
        version: 1,
        type: 'execute',
        requestId: 'run',
        argv: ['sh'],
        env: Object.fromEntries(
          Array.from({ length: 513 }, (_, index) => [`V${index}`, 'value']),
        ),
        cwd: '/workspace',
        uid: 1000,
        gid: 1000,
        tty: false,
      },
      {
        version: 1,
        type: 'execute',
        requestId: 'run',
        argv: ['sh'],
        env: {},
        cwd: 'relative',
        uid: 0,
        gid: -1,
        tty: 'no',
        timeoutMs: 0,
      },
      { version: 1, type: 'stdin', requestId: 'run' },
      { version: 1, type: 'stdin', requestId: 'run', data: 'not-base64' },
      { version: 1, type: 'resize', requestId: 'run', columns: 0, rows: 65_536 },
      { version: 1, type: 'cancel', requestId: 'run', reason: '' },
      {
        version: 1,
        type: 'result',
        requestId: 'run',
        exitCode: 256,
        signal: null,
        timedOut: 'no',
      },
      {
        version: 1,
        type: 'error',
        requestId: 'run',
        code: 'unknown',
        message: '',
        expectedVersion: 0,
      },
      { version: 1, type: 'unknown', requestId: 'run' },
    ];
    for (const frame of invalidFrames) {
      expect(() => validateFirecrackerFrame(frame)).toThrow(FirecrackerProtocolError);
    }
  });

  it('rejects malformed JSON and encoded frames above the wire limit', () => {
    const malformed = Buffer.from('{');
    const malformedWire = Buffer.alloc(4 + malformed.length);
    malformedWire.writeUInt32BE(malformed.length, 0);
    malformed.copy(malformedWire, 4);
    expect(() => new FirecrackerFrameDecoder().push(malformedWire))
      .toThrow(/invalid JSON/);

    const oversizedFrame = {
      version: 1,
      type: 'execute',
      requestId: 'large',
      argv: ['sh'],
      env: Object.fromEntries(
        Array.from({ length: 5 }, (_, index) => [
          `VALUE_${index}`,
          'x'.repeat(256 * 1024),
        ]),
      ),
      cwd: '/workspace',
      uid: 1000,
      gid: 1000,
      tty: false,
    } as FirecrackerGuestFrame;
    expect(() => encodeFirecrackerFrame(oversizedFrame)).toThrow(/exceeds/);
  });
});
