import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applyFilesystemWritePolicy } from './filesystem-write-policy';

describe('applyFilesystemWritePolicy', () => {
  let root: string;
  let workspace: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-write-policy-'));
    workspace = path.join(root, 'workspace');
    fs.mkdirSync(path.join(workspace, 'allowed'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'blocked'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('makes writable parents read-only and overlays allowed descendants read-write', () => {
    const volumes = applyFilesystemWritePolicy(
      [
        `${workspace}:${workspace}:rw`,
        `${workspace}:/host${workspace}:rw`,
      ],
      [path.join(workspace, 'allowed')],
    );

    expect(volumes).toEqual([
      `${workspace}:${workspace}:ro`,
      `${workspace}:/host${workspace}:ro`,
      `${workspace}/allowed:${workspace}/allowed:rw`,
      `${workspace}/allowed:/host${workspace}/allowed:rw`,
    ]);
  });

  it('keeps an allowlisted mount root writable and preserves existing read-only mounts', () => {
    expect(applyFilesystemWritePolicy(
      [`${workspace}:/host${workspace}:rw`, '/usr:/host/usr:ro'],
      [workspace],
    )).toEqual([
      `${workspace}:/host${workspace}:rw`,
      '/usr:/host/usr:ro',
    ]);
  });

  it.each([
    ['/workspace', '/workspace/allowed'],
    ['/workspace/allowed', '/workspace'],
  ])('removes redundant descendant paths regardless of order', (first, second) => {
    const allowWrite = [first, second].map((value) => value.replace('/workspace', workspace));
    expect(applyFilesystemWritePolicy(
      [`${workspace}:/host${workspace}:rw`],
      allowWrite,
    )).toEqual([`${workspace}:/host${workspace}:rw`]);
  });

  it('treats an empty allowlist as a deny-all host write boundary', () => {
    expect(applyFilesystemWritePolicy(
      [`${workspace}:/host${workspace}:rw`],
      [],
    )).toEqual([`${workspace}:/host${workspace}:ro`]);
  });

  it('keeps only explicit AWF-internal mounts writable', () => {
    const logs = path.join(root, 'logs');
    fs.mkdirSync(logs);
    expect(applyFilesystemWritePolicy(
      [
        `${workspace}:/host${workspace}:rw`,
        `${logs}:/host/home/runner/.copilot/logs:rw`,
      ],
      [],
      new Set([`${logs}:/host/home/runner/.copilot/logs:rw`]),
    )).toEqual([
      `${workspace}:/host${workspace}:ro`,
      `${logs}:/host/home/runner/.copilot/logs:rw`,
    ]);
  });

  it('does not trust custom mounts that target AWF-internal namespaces', () => {
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    const custom = `${outside}:/host/home/runner/.copilot/logs/escape:rw`;

    expect(applyFilesystemWritePolicy(
      [custom],
      [],
      new Set(),
    )).toEqual([`${outside}:/host/home/runner/.copilot/logs/escape:ro`]);
  });

  it('fails closed for missing, unexposed, and symlink-escaping paths', () => {
    expect(() => applyFilesystemWritePolicy(
      [`${workspace}:/host${workspace}:rw`],
      [path.join(workspace, 'missing')],
    )).toThrow('filesystem.allowWrite path is not an existing path within a writable host mount');

    expect(() => applyFilesystemWritePolicy(
      [`${workspace}:/host${workspace}:rw`],
      ['/etc'],
    )).toThrow('filesystem.allowWrite path is not an existing path within a writable host mount');

    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(workspace, 'escape'));
    expect(() => applyFilesystemWritePolicy(
      [`${workspace}:/host${workspace}:rw`],
      [path.join(workspace, 'escape')],
    )).toThrow('filesystem.allowWrite path is not an existing path within a writable host mount');
  });

  it('rejects allowlisted symlink aliases within a writable mount', () => {
    fs.symlinkSync(path.join(workspace, 'blocked'), path.join(workspace, 'alias'));

    expect(() => applyFilesystemWritePolicy(
      [`${workspace}:/host${workspace}:rw`],
      [path.join(workspace, 'alias')],
    )).toThrow('filesystem.allowWrite path is not an existing path within a writable host mount');
  });

  it('does not override a more-specific read-only mount', () => {
    const credential = path.join(workspace, 'allowed', 'credential.json');
    fs.writeFileSync(credential, 'secret');
    expect(() => applyFilesystemWritePolicy(
      [
        `${workspace}:/host${workspace}:rw`,
        `/dev/null:/host${credential}:ro`,
      ],
      [credential],
    )).toThrow('filesystem.allowWrite path is not an existing path within a writable host mount');
  });

  it('checks custom overlays against runner-visible sources', () => {
    const daemonSource = `/daemon${workspace}`;
    const spec = `${daemonSource}:/host/data:rw`;
    expect(applyFilesystemWritePolicy(
      [spec],
      ['/data/allowed'],
      new Set(),
      new Map([[spec, workspace]]),
    )).toEqual([
      `${daemonSource}:/host/data:ro`,
      `${daemonSource}/allowed:/host/data/allowed:rw`,
    ]);
  });

  it('rejects runner-visible symlink aliases for custom overlays', () => {
    fs.symlinkSync(path.join(workspace, 'blocked'), path.join(workspace, 'alias'));
    const spec = `/daemon${workspace}:/host/data:rw`;

    expect(() => applyFilesystemWritePolicy(
      [spec],
      ['/data/alias'],
      new Set(),
      new Map([[spec, workspace]]),
    )).toThrow('filesystem.allowWrite path is not an existing path within a writable host mount');
  });

  it('rejects traversal even when called without schema validation', () => {
    expect(() => applyFilesystemWritePolicy(
      [`${workspace}:/host${workspace}:rw`],
      ['/../etc'],
    )).toThrow("filesystem.allowWrite path must be absolute without '..'");
  });
});
