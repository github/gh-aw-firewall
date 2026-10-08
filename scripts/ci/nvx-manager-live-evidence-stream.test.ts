import { describe, expect, it } from '@jest/globals';
import { PassThrough } from 'stream';
import { guardStaleChildPipe } from './nvx-manager-live-evidence-stream';

describe('guardStaleChildPipe', () => {
  it('tolerates ECONNRESET after intentional stale-child termination', () => {
    const stream = new PassThrough();
    guardStaleChildPipe(stream, () => true);

    expect(() => stream.emit('error', Object.assign(new Error('read ECONNRESET'), {
      code: 'ECONNRESET',
    }))).not.toThrow();
  });

  it.each([
    ['ECONNRESET before intentional termination', 'ECONNRESET', false],
    ['an unexpected error after intentional termination', 'EIO', true],
  ])('throws %s', (_name, code, intentionalTermination) => {
    const stream = new PassThrough();
    const error = Object.assign(new Error(`read ${code}`), { code });
    guardStaleChildPipe(stream, () => intentionalTermination);

    expect(() => stream.emit('error', error)).toThrow(error);
  });
});
