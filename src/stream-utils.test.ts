import { Writable } from 'stream';
import { writeWithBackpressure } from './stream-utils';

function createDestination(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

describe('writeWithBackpressure', () => {
  it('skips empty buffers', async () => {
    const destination = createDestination();
    const write = jest.spyOn(destination, 'write');

    await writeWithBackpressure(destination, Buffer.alloc(0));

    expect(write).not.toHaveBeenCalled();
  });

  it('resolves when the destination completes an accepted write', async () => {
    const destination = createDestination();
    const data = Buffer.from('data');
    const write = jest.spyOn(destination, 'write');

    await writeWithBackpressure(destination, data);

    expect(write).toHaveBeenCalledWith(data, expect.any(Function));
    expect(destination.listenerCount('error')).toBe(0);
  });

  it('waits for a backpressured write to complete', async () => {
    const destination = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        setImmediate(callback);
      },
    });

    const result = writeWithBackpressure(destination, Buffer.from('data'));
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    await expect(result).resolves.toBeUndefined();
    expect(destination.listenerCount('error')).toBe(0);
  });

  it('rejects asynchronous errors from an accepted write', async () => {
    const error = new Error('write failed');
    const destination = new Writable({
      write(_chunk, _encoding, callback) {
        setImmediate(() => callback(error));
      },
    });

    const result = writeWithBackpressure(destination, Buffer.from('data'));

    await expect(result).rejects.toBe(error);
    expect(destination.listenerCount('error')).toBe(0);
  });
});
