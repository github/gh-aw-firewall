/**
 * Process-lifetime wiring for dynamic enclave delegation.
 *
 * `prepareEnclaves` takes custody of the compiler handoff and stages it into
 * AWF-private state; this module starts the admission authority once the
 * containers and the trusted gateway are up, and stops it — revoking every
 * outstanding identity — during teardown.
 */

import * as fs from 'fs';
import { logger } from '../logger';
import type { WrapperConfig } from '../types';
import { createEnclaveInformationBudgetLedger } from './information-budget';
import { resolveEnclavePaths } from './paths';
import { readStagedEnclaveDynamicDelegationHandoff } from './dynamic-delegation-handoff';
import {
  DynamicDelegationService,
  ENCLAVE_DYNAMIC_ENTRY_ID,
  resolveDynamicDelegationRunId,
} from './dynamic-delegation-service';
import {
  startDynamicDelegationChannel,
  type DynamicDelegationChannel,
} from './dynamic-delegation-channel';

interface RunningDelegation {
  configuration: WrapperConfig;
  service: DynamicDelegationService;
  channel?: DynamicDelegationChannel;
}

let running: RunningDelegation | undefined;

/** Whether this run declares a dynamic agent enclave entry. */
export function isEnclaveDynamicEnabled(config: WrapperConfig): boolean {
  return config.enclaves?.enabled === true
    && config.enclaves.executors.agent.enabled === true
    && config.enclaves.executors.agent.dynamic !== undefined;
}

/**
 * Starts the dynamic admission authority.
 *
 * Recovery runs first and must succeed: until mcpg's labelled state has been
 * inspected, swept, and transactionally reconciled, AWF refuses to admit any
 * dynamic repository. A recovery failure aborts the run rather than starting
 * an agent whose every enclave call would fail.
 */
export async function startEnclaveDynamicDelegation(
  config: WrapperConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!isEnclaveDynamicEnabled(config)) return;
  if (running) throw new Error('Enclaves: dynamic delegation is already owned by an active run');
  const policy = config.enclaves!.executors.agent.dynamic!;
  const paths = resolveEnclavePaths(config.workDir);
  const handoff = readStagedEnclaveDynamicDelegationHandoff(paths);
  if (!handoff) {
    throw new Error(
      'Enclaves: the staged mcpg delegation-control handoff is missing or unreadable; dynamic '
      + 'repository admission cannot start and never falls back to a static seed catalog, a '
      + 'job-lifetime identity, or a broader policy.',
    );
  }
  const runId = resolveDynamicDelegationRunId(env);
  if (!runId) {
    throw new Error(
      'Enclaves: GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT are required to bind dynamic enclave '
      + "identities to the compiler's delegation envelope.",
    );
  }
  const service = new DynamicDelegationService({
    policy,
    identity: { runId, entryId: ENCLAVE_DYNAMIC_ENTRY_ID },
    handoff,
    // Host-side mirror of the run's per-repository disclosure balances. The
    // broker holds the single live ledger that both executors debit; this
    // instance records the same admissions so the host's audit and quota view
    // stay complete without ever forking a balance.
    ledger: createEnclaveInformationBudgetLedger(
      new Map(config.enclaves!.privateRepos.map(
        (repository) => [repository.repo, { sensitivity: repository.sensitivity }],
      )),
    ),
    auditPath: paths.delegationAuditPath,
  });
  await service.recover();
  const channel = config.enclaves!.executors.agent.runtime === 'docker'
    ? undefined
    : startDynamicDelegationChannel({
      directory: paths.delegationChannelDir,
      service,
    });
  running = { configuration: config, service, channel };
  logger.info('Enclaves: dynamic repository admission is live and reconciled with mcpg.');
}

/** Host execution takes custody of each invocation's bearer; the broker never receives it. */
export function getEnclaveHostDynamicAuthority(config: WrapperConfig): DynamicDelegationService {
  if (!running || running.configuration !== config || !running.service.isAdmitting
    || config.enclaves?.executors.agent.runtime !== 'docker') {
    throw new Error('Enclaves: trusted host dynamic admission is not ready');
  }
  return running.service;
}

/**
 * Stops the admission authority and revokes every identity still carrying this
 * run's labels. Docker retains unresolved authority state and fails closed;
 * the legacy container-runner path reports the existing best-effort warning.
 */
export async function stopEnclaveDynamicDelegation(config: WrapperConfig): Promise<void> {
  const active = running;
  if (!active) return;
  if (active.configuration !== config) {
    throw new Error('Enclaves: dynamic delegation is owned by another run');
  }
  let shutdownError: unknown;
  try { await active.channel?.stop(); } catch (error) { shutdownError = error; }
  try {
    await active.service.shutdown();
    running = undefined;
  } catch {
    logger.warn(
      'Enclaves: dynamic enclave identities may still be live in mcpg; see the host-private '
      + 'delegation audit for the unreconciled state.',
    );
    if (config.enclaves?.executors.agent.runtime === 'docker') {
      throw new Error('Enclaves: host dynamic revocation is unresolved; private recovery state is preserved');
    }
    running = undefined;
  }
  if (!config.keepContainers) {
    try {
      fs.rmSync(resolveEnclavePaths(config.workDir).delegationChannelDir, {
        recursive: true,
        force: true,
      });
    } catch {
      // The private root is removed wholesale by teardownEnclaves.
    }
  }
  if (shutdownError !== undefined) throw shutdownError;
}

/** @internal Test-only accessor for the running delegation runtime. */
export const enclaveDynamicDelegationTestHelpers = {
  /** Stops any leftover channel loop and forgets the runtime. */
  async reset(): Promise<void> {
    const active = running;
    running = undefined;
    if (active) await active.channel?.stop();
  },
  get running(): RunningDelegation | undefined {
    return running;
  },
};
