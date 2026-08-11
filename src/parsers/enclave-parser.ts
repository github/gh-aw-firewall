import {
  ENCLAVE_AGENT_EXECUTOR_DEFAULTS,
  ENCLAVE_SCRIPT_EXECUTOR_DEFAULTS,
  type EnclaveRepository,
  type EnclavesConfig,
  type RawEnclaveAgentEntry,
  type RawEnclaveEntry,
  type RawEnclaveScriptEntry,
  type RawEnclavesConfig,
} from '../types/enclave-options';

function isScriptEntry(entry: RawEnclaveEntry): entry is RawEnclaveScriptEntry {
  return Object.prototype.hasOwnProperty.call(entry, 'script');
}

function isAgentEntry(entry: RawEnclaveEntry): entry is RawEnclaveAgentEntry {
  return Object.prototype.hasOwnProperty.call(entry, 'agent');
}

/**
 * Merges the per-entry repository lists into the single shared catalog.
 *
 * Repositories declared by more than one executor entry MUST agree on their
 * sensitivity: both executors debit the same live per-repository budget, so a
 * conflicting declaration is preserved as a duplicate and rejected by
 * `validateEnclavesConfig` rather than silently resolved here.
 */
function mergeRepositories(entries: RawEnclaveEntry[]): EnclaveRepository[] {
  const merged: EnclaveRepository[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    for (const repository of entry.repos ?? []) {
      const key = `${repository.repo.toLowerCase()}\u0000${repository.sensitivity}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({ ...repository });
    }
  }
  return merged;
}

function entryCommon(entry: RawEnclaveEntry | undefined): object {
  if (!entry) return {};
  return {
    ...(entry.runtime !== undefined && { runtime: entry.runtime }),
    ...(entry.image !== undefined && { image: entry.image }),
    ...(entry.memoryLimit !== undefined && { memoryLimit: entry.memoryLimit }),
    ...(entry.cpuLimit !== undefined && { cpuLimit: entry.cpuLimit }),
    ...(entry.pidsLimit !== undefined && { pidsLimit: entry.pidsLimit }),
    ...(entry.tmpfsLimit !== undefined && { tmpfsLimit: entry.tmpfsLimit }),
    ...(entry.maxOutputBytes !== undefined && { maxOutputBytes: entry.maxOutputBytes }),
    ...(entry.maxInvocations !== undefined && { maxInvocations: entry.maxInvocations }),
  };
}

/**
 * Normalizes the gh-aw keyed-array enclave frontmatter into AWF's trusted
 * runtime configuration.
 *
 * Structural violations fail closed at parse time: an entry must carry exactly
 * one `script` or `agent` key, and at most one entry may exist per executor
 * kind.
 */
export function normalizeEnclavesConfig(
  raw: RawEnclavesConfig | undefined,
): EnclavesConfig | undefined {
  if (!raw) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error('enclaves must be an array of executor entries');
  }

  let script: RawEnclaveScriptEntry | undefined;
  let agent: RawEnclaveAgentEntry | undefined;

  for (const entry of raw) {
    const scriptEntry = isScriptEntry(entry);
    const agentEntry = isAgentEntry(entry);
    if (scriptEntry === agentEntry) {
      throw new Error('each enclaves entry must declare exactly one "script" or "agent" key');
    }
    if (scriptEntry) {
      if (script) throw new Error('enclaves may declare at most one "script" entry');
      script = entry;
    } else if (agentEntry) {
      if (agent) throw new Error('enclaves may declare at most one "agent" entry');
      agent = entry;
    }
  }

  return {
    enabled: raw.length > 0,
    privateRepos: mergeRepositories(raw),
    executors: {
      script: {
        ...ENCLAVE_SCRIPT_EXECUTOR_DEFAULTS,
        ...entryCommon(script),
        ...script?.script,
        enabled: script !== undefined,
        timeout: script?.timeout ?? ENCLAVE_SCRIPT_EXECUTOR_DEFAULTS.timeout,
      },
      agent: {
        ...ENCLAVE_AGENT_EXECUTOR_DEFAULTS,
        ...entryCommon(agent),
        ...agent?.agent,
        enabled: agent !== undefined,
        timeout: agent?.timeout ?? ENCLAVE_AGENT_EXECUTOR_DEFAULTS.timeout,
      },
    },
  };
}
