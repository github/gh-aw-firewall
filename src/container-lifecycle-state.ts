let agentExternallyKilled = false;

export function markAgentExternallyKilled(): void {
  agentExternallyKilled = true;
}

export function isAgentExternallyKilled(): boolean {
  return agentExternallyKilled;
}

function resetAgentExternallyKilled(): void {
  agentExternallyKilled = false;
}

/**
 * @internal Exposed only for unit tests — not part of the public API.
 */
// ts-prune-ignore-next
export const containerLifecycleStateTestHelpers = { resetAgentExternallyKilled };
