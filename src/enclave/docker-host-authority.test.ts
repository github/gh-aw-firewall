import fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { WrapperConfig } from '../types';
import { normalizeEnclavesConfig } from '../parsers/enclave-parser';
import type { DockerHostAuthoritySettlement, DockerHostExecutorEntry } from './docker-host-executor';
import type { DynamicDelegationService } from './dynamic-delegation-service';
import type { HostExecutorInvocationPlan } from './host-executor-server';
import { typedDynamicEnclavePolicyFixture } from './dynamic-policy.test-utils';
import { createDockerHostAuthority } from './docker-host-authority';
import { deriveEnclaveSeedId, resolveEnclavePaths, type EnclavePaths } from './paths';

describe('Docker host authority custody and settlement', () => {
  let directory: string;
  let paths: EnclavePaths;
  let config: WrapperConfig;
  const runId = 'c'.repeat(32);
  const identity = 'trusted-enclave-identity-0123456789';
  const entries: DockerHostExecutorEntry[] = [{
    entryId: 'agent', executorKind: 'agent', config: { githubEnabled: true },
    hostWritableBytes: 0, aggregateWritableBytes: 0,
  }];
  const plan = { invocationId: 'd'.repeat(32) } as HostExecutorInvocationPlan;
  const usage: DockerHostAuthoritySettlement = {
    outcome: 'executor-failure', outputBytes: 11, executionSeconds: 3,
    cleanupComplete: true, uncertain: false,
  };

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-docker-authority-'));
    paths = { ...resolveEnclavePaths(directory), githubAgentIdPath: path.join(directory, 'github-agent-id') };
    config = {
      enclaves: normalizeEnclavesConfig([
        { script: {}, repos: [{ repo: 'Octo/Private', sensitivity: 'internal' }] },
        { agent: { model: 'trusted-model' }, dynamic: typedDynamicEnclavePolicyFixture() },
      ]),
    } as WrapperConfig;
    fs.writeFileSync(paths.githubAgentIdPath, `${identity}\n`, { mode: 0o600 });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('retains startup identity custody and resolves only trusted static seeds', async () => {
    const authority = createDockerHostAuthority(config, paths, runId, entries);
    fs.writeFileSync(paths.githubAgentIdPath, 'changed-after-custody');
    const signal = new AbortController().signal;
    expect(await authority.resolveAgentAuthority({
      ...plan, seedId: deriveEnclaveSeedId(runId, 'octo/private'),
    }, signal)).toEqual({ githubAgentId: identity, repository: 'octo/private' });
    await expect(authority.resolveAgentAuthority(plan, signal)).rejects.toThrow(/trusted seed catalog/);
    await expect(authority.resolveAgentAuthority({ ...plan, selector: 'octo/private' }, signal))
      .rejects.toThrow(/admission denied/);
  });

  it.each(['symlink', 'hardlink', 'mode', 'owner', 'directory', 'size', 'identity'] as const)(
    'rejects unsafe identity custody (%s)', violation => {
      if (violation === 'symlink' || violation === 'directory') {
        fs.renameSync(paths.githubAgentIdPath, path.join(directory, 'original'));
        if (violation === 'symlink') fs.symlinkSync(path.join(directory, 'original'), paths.githubAgentIdPath);
        else fs.mkdirSync(paths.githubAgentIdPath, { mode: 0o600 });
      } else if (violation === 'hardlink') {
        fs.linkSync(paths.githubAgentIdPath, path.join(directory, 'alias'));
      } else if (violation === 'mode') {
        fs.chmodSync(paths.githubAgentIdPath, 0o644);
      } else if (violation === 'owner') {
        const stat = fs.statSync(paths.githubAgentIdPath);
        jest.spyOn(fs, 'fstatSync').mockReturnValue(Object.assign(stat, { uid: stat.uid + 1 }));
      } else {
        fs.writeFileSync(paths.githubAgentIdPath, violation === 'size' ? 'a'.repeat(130) : 'invalid-identity');
      }
      expect(() => createDockerHostAuthority(config, paths, runId, entries))
        .toThrow(violation === 'symlink' ? /ELOOP/ : violation === 'identity' ? /identity is invalid/ : /private custody file/);
    },
  );

  it('does not read identity custody when GitHub is disabled and rejects cancelled admission', async () => {
    fs.unlinkSync(paths.githubAgentIdPath);
    const authority = createDockerHostAuthority(config, paths, runId, []);
    expect(await authority.resolveAgentAuthority(plan, new AbortController().signal)).toEqual({});
    const controller = new AbortController();
    controller.abort();
    await expect(authority.resolveAgentAuthority(plan, controller.signal)).rejects.toThrow(/admission cancelled/);
  });

  it('memoizes settlement per invocation and preserves maximum charging for uncertain usage', async () => {
    const authority = createDockerHostAuthority(config, paths, runId, []);
    const service = { settle: jest.fn().mockResolvedValue({ revoked: true }) };
    authority.authorities.set(plan.invocationId, { service: service as unknown as DynamicDelegationService });
    const settlement = authority.settleAuthority(plan, { ...usage, cleanupComplete: false });
    expect(authority.settleAuthority(plan, usage)).toBe(settlement);
    await expect(settlement).resolves.toEqual({ revoked: true });
    expect(service.settle).toHaveBeenCalledTimes(1);
    expect(service.settle).toHaveBeenCalledWith({
      version: 1, invocationId: plan.invocationId, outcome: 'agent-failure',
      outputBytes: 8192, executionSeconds: 120,
    });
    expect(authority.settlementFailed).toBe(false);
  });

  it.each(['unrevoked', 'rejected'] as const)('retains settlement failure state (%s)', async failure => {
    const authority = createDockerHostAuthority(config, paths, runId, []);
    const service = {
      settle: failure === 'unrevoked' ? jest.fn().mockResolvedValue({ revoked: false })
        : jest.fn().mockRejectedValue(new Error('settlement unavailable')),
    };
    authority.authorities.set(plan.invocationId, { service: service as unknown as DynamicDelegationService });
    if (failure === 'unrevoked') {
      await expect(authority.settleAuthority(plan, usage)).resolves.toEqual({ revoked: false });
    } else {
      await expect(authority.settleAuthority(plan, usage)).rejects.toThrow('settlement unavailable');
    }
    expect(authority.settlementFailed).toBe(true);
  });
});
