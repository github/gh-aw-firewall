import type { AwfFileConfig } from '../config-file';
import {
  BOUNDED_AGENT_DEFAULTS,
  type BoundedAgentRepository,
  type BoundedAgentsConfig,
} from '../types/bounded-agent-options';

/**
 * Normalizes the raw `boundedAgents` section of an AWF config file into a
 * fully-resolved {@link BoundedAgentsConfig}, applying
 * {@link BOUNDED_AGENT_DEFAULTS} for any field left unset.
 *
 * By the time this runs, `raw` has already passed schema validation
 * (`validateAwfFileConfig` / docs/awf-config.schema.json), so bounds and enums
 * are assumed to already hold. This function only fills in defaults — it does
 * not re-validate repository shape, uniqueness, runtime availability, or the
 * API-proxy requirement (see `src/bounded-agent/preflight.ts` for the
 * fail-closed checks).
 *
 * Unlike `boundedQueries`, there is no legacy bare-string `privateRepos`
 * compatibility path: `boundedAgents` is new in this release, so every entry
 * must already be the explicit `{ repo, sensitivity }` object form.
 *
 * Returns `undefined` when `raw` is `undefined`, i.e. the config file did not
 * include a `boundedAgents` section at all. When the section is present (even
 * as `{}`), a fully-defaulted config is always returned.
 */
export function normalizeBoundedAgentsConfig(
  raw: AwfFileConfig['boundedAgents'] | undefined,
): BoundedAgentsConfig | undefined {
  if (!raw) return undefined;

  const privateRepos: BoundedAgentRepository[] = (raw.privateRepos ?? []).map((entry) => ({
    repo: entry.repo,
    sensitivity: entry.sensitivity,
  }));

  return {
    // Only an explicit `true` enables bounded agents; anything else (including
    // omission) normalizes to disabled.
    enabled: raw.enabled === true,
    privateRepos,
    runtime: raw.runtime ?? BOUNDED_AGENT_DEFAULTS.runtime,
    engine: raw.engine ?? BOUNDED_AGENT_DEFAULTS.engine,
    profile: raw.profile ?? BOUNDED_AGENT_DEFAULTS.profile,
    model: raw.model ?? BOUNDED_AGENT_DEFAULTS.model,
    timeout: raw.timeout ?? BOUNDED_AGENT_DEFAULTS.timeout,
    memoryLimit: raw.memoryLimit ?? BOUNDED_AGENT_DEFAULTS.memoryLimit,
    cpuLimit: raw.cpuLimit ?? BOUNDED_AGENT_DEFAULTS.cpuLimit,
    pidsLimit: raw.pidsLimit ?? BOUNDED_AGENT_DEFAULTS.pidsLimit,
    tmpfsLimit: raw.tmpfsLimit ?? BOUNDED_AGENT_DEFAULTS.tmpfsLimit,
    maxOutputBytes: raw.maxOutputBytes ?? BOUNDED_AGENT_DEFAULTS.maxOutputBytes,
    maxTaskBytes: raw.maxTaskBytes ?? BOUNDED_AGENT_DEFAULTS.maxTaskBytes,
    maxInvocations: raw.maxInvocations ?? BOUNDED_AGENT_DEFAULTS.maxInvocations,
    maxModelRequests: raw.maxModelRequests ?? BOUNDED_AGENT_DEFAULTS.maxModelRequests,
    maxModelTokens: raw.maxModelTokens ?? BOUNDED_AGENT_DEFAULTS.maxModelTokens,
  };
}
