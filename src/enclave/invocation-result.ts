import { constants, promises as fs } from 'fs';
import { TextDecoder } from 'util';
import {
  canonicalizeSchemaValue,
  validateValueAgainstSchema,
  type FiniteSchemaNode,
} from '../bounded-execution/finite-schema';
import { HOST_EXECUTOR_MAX_RESULT_BYTES } from './host-executor-protocol';

export async function readBoundedEnclaveResult(
  outputPath: string,
  schema: FiniteSchemaNode,
  maxBytes: number,
): Promise<string | undefined> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > HOST_EXECUTOR_MAX_RESULT_BYTES) {
    return undefined;
  }
  let handle;
  try {
    handle = await fs.open(outputPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes) return undefined;
    const bytes = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(bytes, 0, maxBytes + 1, 0);
    if (bytesRead > maxBytes) return undefined;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead));
    const parsed: unknown = JSON.parse(text);
    if (!validateValueAgainstSchema(schema, parsed)) return undefined;
    const canonical = canonicalizeSchemaValue(schema, parsed);
    if (Buffer.byteLength(canonical, 'utf8') > maxBytes) return undefined;
    return canonical;
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}
