import { PassThrough, Readable } from 'stream';
import { readSandboxStatus } from './sandbox-status';

describe('Bubblewrap sandbox status', () => {
  it.each(['\n', ''])('accepts fragmented JSON with terminator %j', async (terminator) => {
    const status = readSandboxStatus(Readable.from(['{"child-', 'pid":', `4200}${terminator}`]));
    await expect(status.pid).resolves.toBe(4200);
    await expect(status.completed).resolves.toBeUndefined();
  });

  it('reports the PID before EOF and drains subsequent status records', async () => {
    const source = new PassThrough();
    const status = readSandboxStatus(source);
    source.write('{"child-pid":4200}\n');
    await expect(status.pid).resolves.toBe(4200);
    expect(source.destroyed).toBe(false);
    source.end('{"exit-code":0}\n');
    await expect(status.completed).resolves.toBeUndefined();
    expect(source.destroyed).toBe(true);
  });

  it.each([
    ['', /did not report/],
    ['{not-json}\n', /malformed/],
    ['null\n', /valid child-pid/],
    ['{}\n', /valid child-pid/],
    ['{"child-pid":"4200"}\n', /valid child-pid/],
    ['{"child-pid":0}\n', /valid child-pid/],
    ['{"child-pid":-1}\n', /valid child-pid/],
    ['{"child-pid":1.5}\n', /valid child-pid/],
    ['{"child-pid":9007199254740992}\n', /valid child-pid/],
    [' '.repeat(64 * 1024 + 1), /bounded size limit/],
  ])('rejects invalid status case %#', async (contents, error) => {
    const status = readSandboxStatus(Readable.from([contents]));
    await expect(status.pid).rejects.toThrow(error);
    await expect(status.completed).rejects.toThrow(error);
  });

  it('accepts the exact byte limit but enforces it after finding a PID', async () => {
    const contents = '{"child-pid":4200}\n';
    const source = new PassThrough();
    const status = readSandboxStatus(source);
    source.write(contents.padEnd(64 * 1024, ' '));
    await expect(status.pid).resolves.toBe(4200);
    source.end(' ');
    await expect(status.completed).rejects.toThrow(/bounded size limit/);

    const bounded = readSandboxStatus(Readable.from([contents.padEnd(64 * 1024, ' ')]));
    await expect(bounded.pid).resolves.toBe(4200);
    await expect(bounded.completed).resolves.toBeUndefined();
  });

  it('propagates status pipe errors to both promises', async () => {
    const source = new PassThrough();
    const status = readSandboxStatus(source);
    source.destroy(new Error('status pipe failed'));
    await expect(status.pid).rejects.toThrow('status pipe failed');
    await expect(status.completed).rejects.toThrow('status pipe failed');
  });
});
