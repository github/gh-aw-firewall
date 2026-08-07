import type { RawEnclavesConfig } from '../types/enclave-options';
import {
  ENCLAVE_AGENT_EXECUTOR_DEFAULTS,
  ENCLAVE_SCRIPT_EXECUTOR_DEFAULTS,
  type EnclavesConfig,
} from '../types/enclave-options';

/** Applies trusted defaults without enabling either executor implicitly. */
export function normalizeEnclavesConfig(
  raw: RawEnclavesConfig | undefined,
): EnclavesConfig | undefined {
  if (!raw) return undefined;

  const script = raw.executors?.script;
  const agent = raw.executors?.agent;

  return {
    enabled: raw.enabled === true,
    privateRepos: (raw.privateRepos ?? []).map((entry) => ({ ...entry })),
    executors: {
      script: {
        ...ENCLAVE_SCRIPT_EXECUTOR_DEFAULTS,
        ...script,
        enabled: script?.enabled === true,
      },
      agent: {
        ...ENCLAVE_AGENT_EXECUTOR_DEFAULTS,
        ...agent,
        enabled: agent?.enabled === true,
      },
    },
  };
}
