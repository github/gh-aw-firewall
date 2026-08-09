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
});
