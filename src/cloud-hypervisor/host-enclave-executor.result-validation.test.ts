import { promises as fs } from 'fs';
import * as path from 'path';
import type { FiniteSchemaNode } from '../bounded-execution/finite-schema';
import { readBoundedCloudHypervisorEnclaveResult } from './host-enclave-executor';
import { useExecutorScratchDirectory } from './host-enclave-executor.test-utils';

describe('readBoundedCloudHypervisorEnclaveResult', () => {
  const scratch = useExecutorScratchDirectory();

  it('returns canonical schema-validated JSON within the byte bound', async () => {
    const output = path.join(scratch.directory, 'out');
    await fs.writeFile(output, '{"count":2,"ok":true}');
    const schema: FiniteSchemaNode = {
      type: 'object',
      fields: [
        { name: 'ok', schema: { type: 'boolean' } },
        { name: 'count', schema: { type: 'integer', minimum: 0, maximum: 4 } },
      ],
    };

    await expect(readBoundedCloudHypervisorEnclaveResult(output, schema, 64))
      .resolves.toBe('{"ok":true,"count":2}');
  });

  it.each([
    ['invalid JSON', '{'],
    ['schema mismatch', '{"ok":"yes"}'],
    ['empty result', ''],
  ])('rejects %s', async (_label, contents) => {
    const output = path.join(scratch.directory, 'out');
    await fs.writeFile(output, contents);
    await expect(readBoundedCloudHypervisorEnclaveResult(
      output,
      { type: 'boolean' },
      64,
    )).resolves.toBeUndefined();
  });

  it('rejects oversized, invalid UTF-8, and symlinked results', async () => {
    const output = path.join(scratch.directory, 'out');
    await fs.writeFile(output, 'true ');
    await expect(readBoundedCloudHypervisorEnclaveResult(
      output,
      { type: 'boolean' },
      4,
    )).resolves.toBeUndefined();

    await fs.writeFile(output, Buffer.from([0xff]));
    await expect(readBoundedCloudHypervisorEnclaveResult(
      output,
      { type: 'boolean' },
      64,
    )).resolves.toBeUndefined();

    const target = path.join(scratch.directory, 'target');
    await fs.writeFile(target, 'true');
    await fs.rm(output);
    await fs.symlink(target, output);
    await expect(readBoundedCloudHypervisorEnclaveResult(
      output,
      { type: 'boolean' },
      64,
    )).resolves.toBeUndefined();
  });
});
