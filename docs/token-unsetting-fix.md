# Token Unsetting Security Fix

## Problem

The entrypoint script (PID 1) in the agent container had sensitive tokens (GITHUB_TOKEN, OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.) in its environment. While the one-shot-token library successfully cached these tokens in the agent process and cleared them from `/proc/self/environ`, the entrypoint's environment at `/proc/1/environ` still contained the tokens, making them accessible to malicious code.

## Solution

Modified the entrypoint to unset all sensitive tokens from its own environment after the agent process has started and cached them. This is implemented in both chroot and non-chroot execution modes.

### Implementation Details

1. **Added `unset_sensitive_tokens()` function** (entrypoint.sh:145-176)
   - Maintains a list of sensitive token environment variables
   - Iterates through the list and unsets each token from the parent shell
   - Logs which tokens were unset

2. **Modified chroot mode execution** (entrypoint.sh:449-468)
   - Changed from `exec chroot ...` to `chroot ... &` (run in background)
   - Added poll-based wait (up to 1 second, 100ms intervals) to allow agent to initialize and cache tokens
   - Call `unset_sensitive_tokens()` to clear tokens from parent shell
   - Use `wait $AGENT_PID` to wait for agent completion
   - Exit with agent's exit code

3. **Modified non-chroot mode execution** (entrypoint.sh:484-499)
   - Changed from `exec capsh ...` to `capsh ... &` (run in background)
   - Added poll-based wait (up to 1 second, 100ms intervals) to allow agent to initialize and cache tokens
   - Call `unset_sensitive_tokens()` to clear tokens from parent shell
   - Use `wait $AGENT_PID` to wait for agent completion
   - Exit with agent's exit code

4. **Updated one-shot-token library** (one-shot-token/src/lib.rs:32-50)
   - Added `GITHUB_PERSONAL_ACCESS_TOKEN` to default token list
   - Added `CLAUDE_CODE_OAUTH_TOKEN` to default token list
   - Now matches the list in entrypoint.sh

### Token List

The following tokens are unset from the entrypoint's environment:

- **GitHub tokens**: COPILOT_GITHUB_TOKEN, GITHUB_TOKEN, GH_TOKEN, GITHUB_API_TOKEN, GITHUB_PAT, GH_ACCESS_TOKEN, GITHUB_PERSONAL_ACCESS_TOKEN
- **OpenAI tokens**: OPENAI_API_KEY, OPENAI_KEY
- **Anthropic/Claude tokens**: ANTHROPIC_API_KEY, CLAUDE_API_KEY, CLAUDE_CODE_OAUTH_TOKEN
- **Codex tokens**: CODEX_API_KEY

### Timeline

1. **t=0s**: Container starts, entrypoint receives tokens in environment
2. **t=0s**: Entrypoint starts agent command in background
3. **t=0-1s**: Agent initializes, reads tokens via getenv(), one-shot-token library caches them
4. **t=≤1s**: Entrypoint calls `unset_sensitive_tokens()`, clearing tokens from `/proc/1/environ`
5. **t=≤1s+**: Agent continues running with cached tokens, `/proc/1/environ` no longer contains tokens
6. **t=end**: Agent completes, entrypoint exits with agent's exit code

### Security Impact

- **Before**: Tokens accessible via `/proc/1/environ` throughout agent execution
- **After**: Tokens accessible via `/proc/1/environ` only for up to 1 second, then cleared
- **Agent behavior**: Unchanged - agent can still read tokens via getenv() (cached by one-shot-token library)

### Testing

Integration test added at `tests/integration/token-unset.test.ts`:
- Verifies GITHUB_TOKEN cleared from `/proc/1/environ` after agent starts
- Verifies OPENAI_API_KEY cleared from `/proc/1/environ` after agent starts
- Verifies ANTHROPIC_API_KEY cleared from `/proc/1/environ` after agent starts
- Verifies multiple tokens cleared simultaneously
- Verifies behavior in both chroot and non-chroot modes
- Verifies agent can still read tokens via getenv() after unsetting

Manual test script at `test-token-unset.sh`:
- Can be run locally with `./test-token-unset.sh`
- Requires sudo and Docker
- Sets test tokens and verifies they are cleared from `/proc/1/environ`

## Notes

- The poll-based wait (up to 1 second, checking every 100ms) gives the agent process time to initialize and cache tokens via the one-shot-token library before the parent shell unsets them. Fast commands exit early without waiting the full second.
- Both token lists (entrypoint.sh and one-shot-token library) must be kept in sync when adding new token types
- The exit code handling is preserved - the entrypoint exits with the agent's exit code
