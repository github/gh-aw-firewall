import * as fs from 'fs';
import type { WrapperConfig } from '../types';
import { normalizePrivateRepositoryKey } from '../bounded-execution/repository-staging';
import type {
  DockerHostAgentAuthority, DockerHostAuthoritySettlement, DockerHostExecutorEntry,
} from './docker-host-executor';
import type { DynamicDelegationService } from './dynamic-delegation-service';
import type { HostExecutorInvocationPlan } from './host-executor-server';
import { deriveEnclaveSeedId, type EnclavePaths } from './paths';

export type DockerHostAuthorityContext = ReturnType<typeof createDockerHostAuthority>;

export function createDockerHostAuthority(
  config: WrapperConfig,
  paths: EnclavePaths,
  runId: string,
  entries: readonly DockerHostExecutorEntry[],
) {
  const authorities = new Map<string, {
    service: DynamicDelegationService; started?: number; binding?: DockerHostAgentAuthority;
    settlement?: Promise<{ revoked: boolean }>;
  }>();
  const state = { authorities, settlementFailed: false };
  const settleAuthority = (
    plan: HostExecutorInvocationPlan,
    usage: DockerHostAuthoritySettlement,
  ): Promise<{ revoked: boolean }> => {
    const authority = authorities.get(plan.invocationId);
    if (!authority) return Promise.resolve({ revoked: true });
    authority.settlement ??= Promise.resolve().then(async () => {
      const limits = config.enclaves!.executors.agent.dynamic!.limits;
      const uncertain = usage.uncertain || !usage.cleanupComplete;
      const receipt = await authority.service.settle({
        version: 1, invocationId: plan.invocationId,
        outcome: usage.outcome === 'executor-failure' ? 'agent-failure' : usage.outcome,
        outputBytes: uncertain ? limits.maxOutputBytes : usage.outputBytes,
        executionSeconds: uncertain ? limits.timeoutSeconds : usage.executionSeconds,
      });
      if (!receipt.revoked) state.settlementFailed = true;
      return { revoked: receipt.revoked };
    }).catch((error) => {
      state.settlementFailed = true;
      throw error;
    });
    return authority.settlement;
  };
  let githubAgentId: string | undefined;
  const staticRepositories = new Map(config.enclaves!.privateRepos.map(({ repo }) => {
    const repository = normalizePrivateRepositoryKey(repo);
    return [deriveEnclaveSeedId(runId, repository), repository];
  }));
  if (entries.some((entry) => entry.executorKind === 'agent' && entry.config.githubEnabled)) {
    const fd = fs.openSync(paths.githubAgentIdPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1
        || (stat.mode & 0o777) !== 0o600 || stat.size > 129) {
        throw new Error('Docker enclave GitHub identity requires a trusted private custody file');
      }
      githubAgentId = fs.readFileSync(fd, 'utf8').trim();
      if (!/^[A-Za-z0-9_-]{32,128}$/.test(githubAgentId)) {
        throw new Error('Docker enclave GitHub identity is invalid');
      }
    } finally { fs.closeSync(fd); }
  }
  const resolveAgentAuthority = async (
    plan: HostExecutorInvocationPlan,
    signal: AbortSignal,
  ): Promise<DockerHostAgentAuthority> => {
    if (signal.aborted) throw new Error('Docker enclave admission cancelled');
    if (plan.selector !== undefined) {
      const binding = authorities.get(plan.invocationId)?.binding;
      if (!binding) throw new Error('Dynamic enclave admission denied');
      return binding;
    }
    if (!githubAgentId) return {};
    const repository = plan.seedId && staticRepositories.get(plan.seedId);
    if (!repository) throw new Error('Static Docker enclave repository is not in the trusted seed catalog');
    return { githubAgentId, repository };
  };
  return Object.assign(state, { settleAuthority, resolveAgentAuthority });
}
