// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());

import * as fs from 'fs';
import * as path from 'path';
import {
  chmodPublicArtifacts,
  chmodRuntimeArtifacts,
  hasPrivateDiagnostics,
  publicArtifactPaths,
} from './artifact-public-permissions';
import { mockExecaSync } from './test-helpers/mock-execa.test-utils';
import { useTempDir } from './test-helpers/docker-test-fixtures.test-utils';

describe('public artifact permission repair', () => {
  const { getDir } = useTempDir('awf-public-permissions-');

  it('repairs only direct runtime files without traversing private subdirectories or links', () => {
    const directory = getDir();
    const publicFile = path.join(directory, 'access.log');
    fs.writeFileSync(publicFile, 'public');
    fs.mkdirSync(path.join(directory, 'private'));
    fs.writeFileSync(path.join(directory, 'private', 'secret.log'), 'private');
    fs.symlinkSync(publicFile, path.join(directory, 'link'));

    chmodRuntimeArtifacts(directory, 'direct-files');

    expect(mockExecaSync.mock.calls).toEqual([
      ['chmod', ['a+rX', directory]],
      ['chmod', ['a+rX', publicFile]],
    ]);
  });

  it('keeps recursive repair for ordinary runtime directories', () => {
    chmodRuntimeArtifacts(getDir(), 'recursive');

    expect(mockExecaSync).toHaveBeenCalledWith('chmod', ['-R', 'a+rX', getDir()]);
  });

  it('excludes broker audits, nested private diagnostics, and links from public repair', () => {
    const directory = getDir();
    const diagnostics = path.join(directory, 'diagnostics');
    fs.mkdirSync(path.join(diagnostics, 'cloud-hypervisor'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'enclave-host-executor.jsonl'), 'private');
    fs.writeFileSync(path.join(diagnostics, 'enclave-host-executor.jsonl'), 'private');
    const publicFile = path.join(diagnostics, 'ordinary.log');
    fs.writeFileSync(publicFile, 'public');
    fs.symlinkSync(publicFile, path.join(directory, 'link'));

    expect(hasPrivateDiagnostics(directory)).toBe(true);
    expect(publicArtifactPaths(directory)).toEqual([publicFile]);

    chmodPublicArtifacts(directory);

    expect(mockExecaSync.mock.calls).toEqual([
      ['chmod', ['a+rX', directory]],
      ['chmod', ['a+rX', diagnostics]],
      ['chmod', ['-R', 'a+rX', publicFile]],
    ]);
  });

  it('retains recursive public repair when no private diagnostics exist', () => {
    expect(hasPrivateDiagnostics(getDir())).toBe(false);

    chmodPublicArtifacts(getDir());

    expect(mockExecaSync).toHaveBeenCalledWith('chmod', ['-R', 'a+rX', getDir()]);
  });

  it.each(['file', 'symlink', 'missing'])('refuses a %s as the public artifact directory', (kind) => {
    const target = path.join(getDir(), 'target');
    if (kind === 'file') fs.writeFileSync(target, 'not a directory');
    else if (kind === 'symlink') fs.symlinkSync(getDir(), target);

    expect(() => chmodPublicArtifacts(target)).toThrow('non-directory path');
    expect(mockExecaSync).not.toHaveBeenCalled();
  });
});
