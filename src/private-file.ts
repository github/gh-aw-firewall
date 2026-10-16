import { constants, promises as fs } from 'fs';

export async function writePrivateFile(
  open: typeof fs.open,
  filePath: string,
  contents: string,
): Promise<void> {
  const handle = await open(
    filePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
