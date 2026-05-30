let agentExternallyKilled = false;

export function markAgentExternallyKilled(): void {
  agentExternallyKilled = true;
}

export function isAgentExternallyKilled(): boolean {
  return agentExternallyKilled;
}

/**
 * Internal test-only reset helper.
 * Do not use in production flows.
 */
export function resetAgentExternallyKilled(): void {
  agentExternallyKilled = false;
}
