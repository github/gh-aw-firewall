import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { WrapperConfig } from '../types';
import { normalizeEnclavesConfig } from '../parsers/enclave-parser';
import { PRIVATE_REPOSITORY_SEED_MAP_VERSION } from '../bounded-execution';
import { typedDynamicEnclavePolicyFixture } from './dynamic-policy.test-utils';
import { deriveHostExecutorRunState } from './host-executor-run-state';
import { deriveEnclaveSeedId, resolveEnclavePaths } from './paths';

describe('trusted host run authority', () => {
  let directory: string;
  const runId = 'a'.repeat(32);
  const repository = { repo: 'octo/private', sensitivity: 'internal' as const };

  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'host-run-authority-')); });
  afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });

  function setup(dynamic: boolean, script: boolean) {
    const config = {
      workDir: directory,
      enableApiProxy: true,
      copilotGithubToken: 'test',
      enclaves: normalizeEnclavesConfig([
        ...(script ? [{ script: {}, repos: [repository] }] : []),
        dynamic
          ? { agent: { model: 'trusted' }, dynamic: typedDynamicEnclavePolicyFixture() }
          : { agent: { model: 'trusted' }, repos: [repository] },
      ]),
    } as WrapperConfig;
    const paths = resolveEnclavePaths(directory, directory);
    fs.mkdirSync(paths.seedsDir, { recursive: true });
    fs.writeFileSync(paths.runIdPath, runId);
    const seedId = deriveEnclaveSeedId(runId, repository.repo);
    if (!dynamic || script) {
      fs.mkdirSync(path.join(paths.seedsDir, seedId));
      fs.writeFileSync(paths.seedMapPath, JSON.stringify({
        version: PRIVATE_REPOSITORY_SEED_MAP_VERSION, runId,
        seeds: [{ ...repository, seedId }],
      }));
    }
    return { config, paths, seedId };
  }

  it('requires explicit backend support for dynamic admission', () => {
    const { config, paths } = setup(true, false);
    expect(() => deriveHostExecutorRunState(config, paths)).toThrow(/trusted dynamic admission/);
  });

  it('supports a dynamic-only entry without a seed-map file or static authority', () => {
    const { config, paths } = setup(true, false);
    expect(fs.existsSync(paths.seedMapPath)).toBe(false);
    expect(deriveHostExecutorRunState(config, paths, 'Docker enclave', { dynamicAgents: true }).entries)
      .toEqual([expect.objectContaining({
        entryId: 'agent', staticSeedIds: [], dynamicAgents: true, timeoutMs: 120_000,
      })]);
  });

  it('does not grant dynamic agents the adjacent script entry seed catalog', () => {
    const { config, paths, seedId } = setup(true, true);
    const { entries } = deriveHostExecutorRunState(config, paths, 'Docker enclave', { dynamicAgents: true });
    expect(entries).toContainEqual(expect.objectContaining({
      entryId: 'script', staticSeedIds: [seedId], dynamicAgents: false,
    }));
    expect(entries).toContainEqual(expect.objectContaining({
      entryId: 'agent', staticSeedIds: [], dynamicAgents: true,
    }));
  });

  it('preserves static configured-union authority and validates the host seed catalog', () => {
    const { config, paths, seedId } = setup(false, true);
    expect(deriveHostExecutorRunState(config, paths).entries)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ entryId: 'script', staticSeedIds: [seedId], dynamicAgents: false }),
        expect.objectContaining({ entryId: 'agent', staticSeedIds: [seedId], dynamicAgents: false }),
      ]));
    fs.rmSync(path.join(paths.seedsDir, seedId), { recursive: true });
    fs.symlinkSync(directory, path.join(paths.seedsDir, seedId));
    expect(() => deriveHostExecutorRunState(config, paths)).toThrow(/real directories/);
  });
});
