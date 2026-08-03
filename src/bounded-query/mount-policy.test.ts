import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { WrapperConfig } from '../types';
import { assertBoundedQueryPrivateRootIsolated, resolvePathThroughExistingAncestor } from './mount-policy';
import { resolveBoundedQueryPaths } from './paths';

function config(workDir: string, volumeMounts?: string[]): WrapperConfig {
  return {
    workDir,
    volumeMounts,
  } as unknown as WrapperConfig;
}

describe('bounded-query private-root mount policy', () => {
  let testRoot: string;
  let workDir: string;
  let privateBase: string;

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join('/var/tmp', 'awf-bounded-query-policy-'));
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-bounded-query-visible-'));
    privateBase = path.join(testRoot, 'private');
    fs.mkdirSync(privateBase);
  });

  afterEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('accepts a dedicated private root outside all agent-visible mounts', () => {
    const paths = resolveBoundedQueryPaths(workDir, privateBase);
    expect(() => assertBoundedQueryPrivateRootIsolated(config(workDir), paths)).not.toThrow();
  });

  it('rejects private state beneath the broad /tmp mount', () => {
    const paths = resolveBoundedQueryPaths(workDir, '/tmp');
    expect(() => assertBoundedQueryPrivateRootIsolated(config(workDir), paths))
      .toThrow(/overlaps agent-visible temporary directory/);
  });

  it('rejects a broad custom mount containing the private root', () => {
    const paths = resolveBoundedQueryPaths(workDir, privateBase);
    expect(() =>
      assertBoundedQueryPrivateRootIsolated(config(workDir, [`${testRoot}:/data:ro`]), paths),
    ).toThrow(/custom volume/);
  });

  it('rejects a nested custom mount inside the private root', () => {
    const paths = resolveBoundedQueryPaths(workDir, privateBase);
    const nested = path.join(paths.root, 'seeds');
    expect(() =>
      assertBoundedQueryPrivateRootIsolated(config(workDir, [`${nested}:/data:ro`]), paths),
    ).toThrow(/custom volume/);
  });

  it('normalizes path traversal before checking overlap', () => {
    const paths = resolveBoundedQueryPaths(workDir, privateBase);
    const traversing = path.join(paths.root, 'seeds', '..');
    expect(() =>
      assertBoundedQueryPrivateRootIsolated(config(workDir, [`${traversing}:/data:ro`]), paths),
    ).toThrow(/custom volume/);
  });

  it('resolves symlink aliases in existing ancestors', () => {
    const paths = resolveBoundedQueryPaths(workDir, privateBase);
    const alias = path.join(testRoot, 'private-alias');
    fs.symlinkSync(privateBase, alias);
    expect(() =>
      assertBoundedQueryPrivateRootIsolated(config(workDir, [`${alias}:/data:ro`]), paths),
    ).toThrow(/custom volume/);
  });

  it('checks daemon-prefixed paths used by DinD bind mounts', () => {
    const daemonRoot = path.join(testRoot, 'daemon');
    fs.mkdirSync(daemonRoot);
    const paths = resolveBoundedQueryPaths(workDir, privateBase);
    expect(() =>
      assertBoundedQueryPrivateRootIsolated(
        { ...config(workDir, [`${testRoot}:/data:ro`]), dockerHostPathPrefix: daemonRoot },
        paths,
      ),
    ).toThrow(/custom volume/);
  });

  it('rejects a workspace that contains the private root', () => {
    const paths = resolveBoundedQueryPaths(workDir, privateBase);
    expect(() =>
      assertBoundedQueryPrivateRootIsolated(config(workDir), paths, {}, testRoot),
    ).toThrow(/agent-visible workspace/);
  });

  it('rejects a configured session-state mount containing the private root', () => {
    const paths = resolveBoundedQueryPaths(workDir, privateBase);
    expect(() =>
      assertBoundedQueryPrivateRootIsolated(
        { ...config(workDir), sessionStateDir: testRoot },
        paths,
      ),
    ).toThrow(/agent session-state directory/);
  });

  it('rejects malformed custom mounts instead of ignoring their source', () => {
    const paths = resolveBoundedQueryPaths(workDir, privateBase);
    expect(() =>
      assertBoundedQueryPrivateRootIsolated(config(workDir, ['named-volume:/data:ro']), paths),
    ).toThrow(/could not parse custom bind mount/);
  });

  it('rejects a chroot binaries source containing the private root', () => {
    const paths = resolveBoundedQueryPaths(workDir, privateBase);
    expect(() =>
      assertBoundedQueryPrivateRootIsolated(
        { ...config(workDir), chrootBinariesSourcePath: testRoot },
        paths,
      ),
    ).toThrow(/chroot binaries source/);
  });

  it('rejects an agent-visible Docker socket path inside the private root', () => {
    const paths = resolveBoundedQueryPaths(workDir, privateBase);
    expect(() =>
      assertBoundedQueryPrivateRootIsolated(
        {
          ...config(workDir),
          enableDind: true,
          awfDockerHost: `unix://${path.join(paths.root, 'docker.sock')}`,
        },
        paths,
      ),
    ).toThrow(/agent Docker socket/);
  });

  it('resolves a missing suffix through a symlinked ancestor', () => {
    const target = path.join(testRoot, 'target');
    const alias = path.join(testRoot, 'alias');
    fs.mkdirSync(target);
    fs.symlinkSync(target, alias);
    expect(resolvePathThroughExistingAncestor(path.join(alias, 'missing', 'leaf')))
      .toBe(path.join(fs.realpathSync.native(target), 'missing', 'leaf'));
  });

  it('rejects relative paths before filesystem resolution', () => {
    expect(() => resolvePathThroughExistingAncestor('../private'))
      .toThrow(/requires an absolute path/);
  });
});
