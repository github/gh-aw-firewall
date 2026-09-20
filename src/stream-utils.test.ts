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

  it('resolves immediately when the destination accepts the write', async () => {
    const destination = createDestination();
    const data = Buffer.from('data');
    const write = jest.spyOn(destination, 'write');

    await writeWithBackpressure(destination, data);

    expect(write).toHaveBeenCalledWith(data);
    expect(destination.listenerCount('drain')).toBe(0);
    expect(destination.listenerCount('error')).toBe(0);
  });

  it('waits for drain when the destination applies backpressure', async () => {
    const destination = createDestination();
    jest.spyOn(destination, 'write').mockReturnValue(false);

    const result = writeWithBackpressure(destination, Buffer.from('data'));
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    destination.emit('drain');
    await expect(result).resolves.toBeUndefined();
    expect(destination.listenerCount('error')).toBe(0);
  });

  it('rejects write errors while waiting for drain', async () => {
    const destination = createDestination();
    jest.spyOn(destination, 'write').mockReturnValue(false);
    const error = new Error('write failed');

    const result = writeWithBackpressure(destination, Buffer.from('data'));
    destination.emit('error', error);

    await expect(result).rejects.toBe(error);
    expect(destination.listenerCount('drain')).toBe(0);
  });
});
