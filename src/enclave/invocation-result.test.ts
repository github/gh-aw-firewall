import { promises as fs } from 'fs';
import * as path from 'path';
import { readBoundedEnclaveResult } from './invocation-result';
import { HOST_EXECUTOR_MAX_RESULT_BYTES } from './host-executor-protocol';
import type { FiniteSchemaNode } from '../bounded-execution/finite-schema';

describe('backend-neutral bounded invocation results', () => {
  let directory: string;
  let output: string;
  const schema: FiniteSchemaNode = { type: 'boolean' };

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(process.cwd(), '.awf-shared-result-'));
    output = path.join(directory, 'out');
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('validates and canonicalizes a bounded JSON value', async () => {
    await fs.writeFile(output, ' true \n');
    await expect(readBoundedEnclaveResult(output, schema, 7)).resolves.toBe('true');
    await fs.writeFile(output, 'false');
    await expect(readBoundedEnclaveResult(output, schema, 5)).resolves.toBe('false');
  });

  it.each(['', 'null', '"true"', 'true false', 'x'.repeat(65)])('rejects invalid or oversized results %j', async (value) => {
    await fs.writeFile(output, value);
    await expect(readBoundedEnclaveResult(output, schema, 64)).resolves.toBeUndefined();
  });

  it('rejects malformed UTF-8 instead of accepting a replacement character', async () => {
    await fs.writeFile(output, Buffer.from([0x22, 0xff, 0x22]));
    await expect(readBoundedEnclaveResult(output, { type: 'string' }, 64))
      .resolves.toBeUndefined();
  });

  it('rejects missing files, directories and symlinks', async () => {
    await expect(readBoundedEnclaveResult(output, schema, 64)).resolves.toBeUndefined();
    await expect(readBoundedEnclaveResult(directory, schema, 64)).resolves.toBeUndefined();
    const target = path.join(directory, 'target');
    await fs.writeFile(target, 'true');
    await fs.symlink(target, output);
    await expect(readBoundedEnclaveResult(output, schema, 64)).resolves.toBeUndefined();
  });

  it.each([0, -1, 1.5, NaN, Infinity, HOST_EXECUTOR_MAX_RESULT_BYTES + 1])(
    'rejects invalid trusted result bounds without allocating: %s', async (bound) => {
      await fs.writeFile(output, 'true');
      await expect(readBoundedEnclaveResult(output, schema, bound)).resolves.toBeUndefined();
    });
});
