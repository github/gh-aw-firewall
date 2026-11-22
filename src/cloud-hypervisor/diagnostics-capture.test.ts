import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BoundedOutputCapture, copyBoundedDiagnostic, readBoundedTail } from './diagnostics-capture';
import { dependencies } from './manager.test-utils';

describe('Cloud Hypervisor diagnostic capture', () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'awf-ch-capture-'));
  });

  afterEach(async () => {
    await fs.rm(scratch, { recursive: true, force: true });
  });

  it.each([0, 4, 32])('reads at most %i trailing bytes', async (limit) => {
    const file = path.join(scratch, 'output.log');
    const contents = Buffer.from('first\nlast\n');
    await fs.writeFile(file, contents);
    expect(await readBoundedTail(file, limit))
      .toEqual(contents.subarray(Math.max(0, contents.length - limit)));
  });

  it.each(['symlink', 'hardlink'] as const)('rejects a %s source', async (kind) => {
    const file = path.join(scratch, 'output.log');
    const link = path.join(scratch, 'linked.log');
    await fs.writeFile(file, 'private');
    if (kind === 'symlink') await fs.symlink(file, link);
    else await fs.link(file, link);
    await expect(readBoundedTail(link, 32)).rejects.toThrow();
    expect(await fs.readFile(file, 'utf8')).toBe('private');
  });

  it('retains bounded stream output but excludes partial public lines', () => {
    const capture = new BoundedOutputCapture(9);
    capture.writable().write(Buffer.from('private\n'));
    capture.append('last\n');
    expect(capture.contents().toString()).toBe('ate\nlast\n');
    expect(capture.publicContents().toString()).toBe('last\n');
    capture.append('unbroken-line');
    expect(capture.contents().length).toBe(9);
    expect(capture.publicContents().length).toBe(0);
  });

  it('ignores missing log sources without creating a destination', async () => {
    const deps = dependencies({
      readFileTail: jest.fn().mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' })),
    });
    await copyBoundedDiagnostic(deps, '/missing.log', '/audit.log', { uid: 1000, gid: 1000 });
    expect(deps.open).not.toHaveBeenCalled();
  });

  it('propagates source errors other than missing files', async () => {
    const error = Object.assign(new Error('denied'), { code: 'EACCES' });
    const deps = dependencies({ readFileTail: jest.fn().mockRejectedValue(error) });
    await expect(copyBoundedDiagnostic(deps, '/source.log', '/audit.log', { uid: 1000, gid: 1000 }))
      .rejects.toBe(error);
    expect(deps.open).not.toHaveBeenCalled();
  });
});
