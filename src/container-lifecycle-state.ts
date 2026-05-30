let agentExternallyKilled = false;

export function markAgentExternallyKilled(): void {
  agentExternallyKilled = true;
}

export function isAgentExternallyKilled(): boolean {
  return agentExternallyKilled;
}

export function resetAgentExternallyKilled(): void {
  agentExternallyKilled = false;
}
