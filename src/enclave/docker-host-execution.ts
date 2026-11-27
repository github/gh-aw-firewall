import type { WrapperConfig } from '../types';
import { getEnclaveHostDynamicAuthority } from './dynamic-delegation';
import type { DockerHostAuthorityContext } from './docker-host-authority';
import type { HostEnclaveExecutorBackend, HostExecutorBackendResult } from './host-executor-server';
import { isValidHostExecutorResult } from './host-executor-protocol';

export function wrapDockerHostExecution(
  config: WrapperConfig,
  backend: HostEnclaveExecutorBackend,
  authorityState: DockerHostAuthorityContext,
): HostEnclaveExecutorBackend {
  const { authorities, settleAuthority } = authorityState;
  const wrapped: HostEnclaveExecutorBackend = {
    async execute(plan, signal) {
      let result: HostExecutorBackendResult = { outcome: 'executor-failure' };
      let executionStarted = false;
      try {
        if (signal.aborted) return { outcome: 'cancelled' };
        if (plan.selector !== undefined) {
          const service = getEnclaveHostDynamicAuthority(config);
          // Retain settlement responsibility even if admission throws after
          // minting an identity (for example, a durable audit write fails).
          authorities.set(plan.invocationId, { service });
          const admission = await service.admit({
            version: 1, invocationId: plan.invocationId,
            selector: plan.selector, schemaHash: plan.schemaHash,
          });
          if (admission.admitted) {
            authorities.get(plan.invocationId)!.binding = {
              repository: admission.repository, githubBearer: admission.executorBearer,
              readMode: admission.readMode,
            };
          } else if (service.isAdmitting) {
            result = { outcome: 'executor-failure', recoverableFailure: true, cleanupComplete: true };
          } else {
            authorityState.settlementFailed = true;
            result = { outcome: 'executor-failure', cleanupComplete: false };
          }
        }
        if (plan.selector === undefined || authorities.get(plan.invocationId)?.binding) {
          if (signal.aborted) result = { outcome: 'cancelled' };
          else {
            executionStarted = true;
            const authority = authorities.get(plan.invocationId);
            if (authority) authority.started = Date.now();
            const execution = await backend.execute(plan, signal);
            result = execution && isValidHostExecutorResult(execution.outcome, execution.result)
              ? execution : { outcome: 'executor-failure', cleanupComplete: false };
          }
        }
      } catch {
        result = {
          outcome: signal.aborted ? 'cancelled' : 'executor-failure',
          ...(executionStarted ? { cleanupComplete: false } : {}),
        };
      }
      const authority = authorities.get(plan.invocationId);
      if (authority) {
        try {
          const uncertainCleanup = result.cleanupComplete === false;
          const receipt = await settleAuthority(plan, {
            outcome: result.outcome, uncertain: uncertainCleanup,
            cleanupComplete: !uncertainCleanup,
            outputBytes: result.result === undefined ? 0 : Buffer.byteLength(result.result),
            executionSeconds: authority.started === undefined ? 0
              : Math.max(0, Math.ceil((Date.now() - authority.started) / 1000)),
          });
          if (!receipt.revoked) throw new Error('Dynamic enclave identity revocation is unresolved');
        } catch {
          authorityState.settlementFailed = true;
          return { outcome: 'executor-failure', cleanupComplete: false };
        } finally {
          authorities.delete(plan.invocationId);
        }
      }
      return result;
    },
    async close() {
      await backend.close?.();
      if (authorityState.settlementFailed) throw new Error('Dynamic Docker enclave settlement requires trusted recovery');
    },
  };
  return wrapped;
}
