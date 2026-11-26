import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  readTrustedArtifactBytes, writeEnclaveArtifactVerificationFiles,
} from './enclave-artifact-attestation';
import { hostPreflightReason } from './host-preflight-progress';

describe('Enclave artifact verification bytes', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awf-enclave-verification-bytes-'));
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('reads a bounded artifact across multiple chunks without following symlinks', async () => {
    const contents = Buffer.alloc(128 * 1024, 'a');
    const artifact = path.join(directory, 'artifact');
    await fs.writeFile(artifact, contents, { mode: 0o400 });
    await expect(readTrustedArtifactBytes(artifact, process.getuid!(), contents.length)).resolves.toEqual(contents);
    const symlink = path.join(directory, 'symlink');
    await fs.symlink(artifact, symlink);
    await expect(readTrustedArtifactBytes(symlink, process.getuid!(), contents.length))
      .rejects.toMatchObject({ code: 'ELOOP' });
  });

  it.each([
    { size: 0, mode: 0o400 },
    { size: 17, mode: 0o400 },
    { size: 1, mode: 0o422 },
  ])('rejects untrusted metadata (size=$size, mode=$mode)', async ({ size, mode }) => {
    const artifact = path.join(directory, 'artifact');
    await fs.writeFile(artifact, Buffer.alloc(size), { mode: 0o600 });
    await fs.chmod(artifact, mode);
    const error = await readTrustedArtifactBytes(artifact, process.getuid!(), 16).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(hostPreflightReason(error)).toBe('file-type');
  });

  it('stages the captured bytes as exclusive read-only files', async () => {
    const manifest = Buffer.from('{"manifest":true}');
    const bundle = Buffer.from('{"bundle":true}');
    const staged = await writeEnclaveArtifactVerificationFiles(directory, manifest, bundle);
    for (const [file, contents] of [[staged.manifestPath, manifest], [staged.bundlePath, bundle]] as const) {
      expect(await fs.readFile(file)).toEqual(contents);
      expect((await fs.stat(file)).mode & 0o777).toBe(0o400);
    }
    await expect(writeEnclaveArtifactVerificationFiles(directory, Buffer.from('replacement'), bundle))
      .rejects.toMatchObject({ code: 'EEXIST' });
    expect(await fs.readFile(staged.manifestPath)).toEqual(manifest);
  });
});
