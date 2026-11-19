import { createHash } from 'crypto';
import { COPILOT_PLACEHOLDER_TOKEN } from '../../src/constants/placeholders';

// The entrypoint logs the command itself. Compare inside the guest without
// putting either the credential-shaped placeholder or the value read in logs.
export function checkCopilotPlaceholder(name: 'COPILOT_TOKEN' | 'COPILOT_GITHUB_TOKEN'): string {
  const expected = createHash('sha256').update(`${COPILOT_PLACEHOLDER_TOKEN}\n`).digest('hex');
  return `test "$(printenv ${name} | sha256sum)" = "${expected}  -" && echo "${name}: placeholder verified"`;
}
