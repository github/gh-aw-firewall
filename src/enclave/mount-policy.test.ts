import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { WrapperConfig } from '../types';
import {
  assertEnclavePrivateRootIsolated,
  assertCloudHypervisorEnclaveExportsIsolated,
  findDockerSocketExposingMount,
  resolvePathThroughExistingAncestor,
} from './mount-policy';
import { resolveEnclavePaths } from './paths';
import { normalizeEnclavesConfig } from '../parsers/enclave-parser';
import { HOST_EXECUTOR_STORAGE_ROOT } from './host-executor-journal';

function config(workDir: string, volumeMounts?: string[]): WrapperConfig {
  return { workDir, volumeMounts } as WrapperConfig;
}

describe('enclave private-root mount policy', () => {
  let testRoot: string;
  let workDir: string;
  let privateBase: string;

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join('/var/tmp', 'awf-enclave-policy-'));
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-enclave-visible-'));
    privateBase = path.join(testRoot, 'private');
    fs.mkdirSync(privateBase);
  });

  afterEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('accepts a dedicated private root outside all primary-agent mounts', () => {
    expect(() => assertEnclavePrivateRootIsolated(
      config(workDir),
      resolveEnclavePaths(workDir, privateBase),
    )).not.toThrow();
  });

  it('rejects private state under the primary-agent temporary mount', () => {
    expect(() => assertEnclavePrivateRootIsolated(
      config(workDir),
      resolveEnclavePaths(workDir, '/tmp'),
    )).toThrow(/temporary directory/);
  });

  it('rejects custom mounts that contain or alias the private root', () => {
    const paths = resolveEnclavePaths(workDir, privateBase);
    expect(() => assertEnclavePrivateRootIsolated(
      config(workDir, [`${testRoot}:/data:ro`]),
      paths,
    )).toThrow(/custom volume/);

    const alias = path.join(testRoot, 'private-alias');
    fs.symlinkSync(privateBase, alias);
    expect(() => assertEnclavePrivateRootIsolated(
      config(workDir, [`${alias}:/data:ro`]),
      paths,
    )).toThrow(/custom volume/);
  });

  it('rejects the agent Docker socket inside private state', () => {
    const paths = resolveEnclavePaths(workDir, privateBase);
    expect(() => assertEnclavePrivateRootIsolated({
      ...config(workDir),
      enableDind: true,
      awfDockerHost: `unix://${path.join(paths.root, 'docker.sock')}`,
    }, paths)).toThrow(/agent Docker socket/);
  });

  it('detects a symlinked custom bind that exposes the Docker socket', () => {
    const socket = path.join(testRoot, 'docker.sock');
    const alias = path.join(testRoot, 'socket-alias');
    fs.writeFileSync(socket, '');
    fs.symlinkSync(socket, alias);
    expect(findDockerSocketExposingMount({
      ...config(workDir, [`${alias}:/run/docker.sock`]),
      awfDockerHost: `unix://${socket}`,
    })).toBe(`${alias}:/run/docker.sock`);
  });

  it('resolves a missing suffix through a symlinked ancestor', () => {
    const target = path.join(testRoot, 'target');
    const alias = path.join(testRoot, 'alias');
    fs.mkdirSync(target);
    fs.symlinkSync(target, alias);
    expect(resolvePathThroughExistingAncestor(path.join(alias, 'missing', 'leaf')))
      .toBe(path.join(fs.realpathSync.native(target), 'missing', 'leaf'));
  });

  it('checks all actual primary exports against private, broker and recovery roots', () => {
    const wrapper = {
      ...config(workDir),
      enclaves: normalizeEnclavesConfig([{
        script: {}, runtime: 'cloud-hypervisor',
        repos: [{ repo: 'octo/private', sensitivity: 'internal' }],
      }]),
    };
    const paths = resolveEnclavePaths(workDir);
    for (const root of [
      paths.root, paths.ingressRoot, paths.hostExecutorJournalDir,
      path.join(path.dirname(paths.hostExecutorJournalDir), 'host-invocations'),
      HOST_EXECUTOR_STORAGE_ROOT,
    ]) {
      for (const source of [root, path.dirname(root), path.join(root, 'child')]) {
        for (const mode of ['ro', 'rw'] as const) {
          expect(() => assertCloudHypervisorEnclaveExportsIsolated(wrapper, [{
            tag: 'runner-temp-gh-aw', source, target: '/data', mode,
          }])).toThrow(/private or recovery state/);
        }
      }
    }
    expect(() => assertCloudHypervisorEnclaveExportsIsolated(wrapper, [{
      tag: 'workspace', source: workDir, target: '/workspace', mode: 'rw',
    }])).not.toThrow();

    const alias = path.join(testRoot, 'private-state-alias');
    fs.symlinkSync(path.dirname(paths.root), alias);
    expect(() => assertCloudHypervisorEnclaveExportsIsolated(wrapper, [{
      tag: 'runner-tool-cache', source: path.join(alias, path.basename(paths.root)),
      target: '/tools', mode: 'ro',
    }])).toThrow(/private or recovery state/);
    expect(() => assertCloudHypervisorEnclaveExportsIsolated({
      ...wrapper, enclaves: { ...wrapper.enclaves!, enabled: false },
    }, [{ tag: 'workspace', source: paths.root, target: '/workspace', mode: 'rw' }]))
      .not.toThrow();
  });
});
