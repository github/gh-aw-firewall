#!/usr/bin/env bash
set -euo pipefail

export PATH="$PWD/.awf-regression/tools/node_modules/.bin:$PATH"
agent=${1:?agent required}
marker=${2:?marker required}
results="$PWD/.awf-regression/results"
mkdir -p "$results"
fail() {
  echo "$*" >&2
  exit 1
}
test -r package.json || fail 'Workspace export is unavailable'
test -n "${HTTPS_PROXY:?}"
test -z "${GH_TOKEN:-}${GITHUB_TOKEN:-}${ANTHROPIC_API_KEY:-}" || fail 'A host credential variable reached the guest'
if node <<'NODE'
let placeholder;
try {
  placeholder = require('./dist/constants/placeholders')?.COPILOT_PLACEHOLDER_TOKEN;
} catch {
  process.exit(2);
}
if (typeof placeholder !== 'string' || placeholder.length === 0) {
  process.exit(2);
}
const names = ['COPILOT_GITHUB_TOKEN', 'COPILOT_TOKEN', 'COPILOT_PROVIDER_API_KEY'];
if (names.some(name => process.env[name] && process.env[name] !== placeholder)) {
  process.exit(1);
}
NODE
then
  :
else
  status=$?
  if [ "$status" -eq 1 ]; then
    fail 'Copilot credential is not isolated'
  fi
  fail 'Copilot placeholder contract is unavailable'
fi
test -z "${OPENAI_API_KEY:-}" || test "$OPENAI_API_KEY" = sk-placeholder-for-api-proxy || fail 'OpenAI credential is not isolated'
test -z "${CODEX_API_KEY:-}" || test "$CODEX_API_KEY" = sk-placeholder-for-api-proxy || fail 'Codex credential is not isolated'
test -z "${ANTHROPIC_AUTH_TOKEN:-}" || test "$ANTHROPIC_AUTH_TOKEN" = sk-ant-placeholder-key-for-credential-isolation || fail 'Anthropic credential is not isolated'

http_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 https://github.com)
case "$http_code" in
  200|301) ;;
  *) echo "Allowed github.com probe failed: $http_code" >&2; exit 1 ;;
esac
blocked_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://example.com) || true
case "$blocked_code" in
  000|403) ;;
  *) echo "Blocked example.com probe unexpectedly returned: $blocked_code" >&2; exit 1 ;;
esac

export HOME="$PWD/.awf-regression/home"
export XDG_CACHE_HOME="$HOME/.cache"
export XDG_CONFIG_HOME="$HOME/.config"
export XDG_STATE_HOME="$HOME/.local/state"
export CODEX_HOME="$HOME/.codex"
export DISABLE_AUTOUPDATER=1
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
mkdir -p "$HOME" "$CODEX_HOME"
"$agent" --version > "$results/agent-version.txt"
prompt="Use your shell tool to write exactly '$marker' followed by a newline to '$results/agent-proof.txt'. Then respond with exactly $marker and nothing else. Do not read other files or make other changes."
case "$agent" in
  copilot)
    copilot --prompt "$prompt" --silent --no-color --stream on --allow-all-tools \
      --disable-builtin-mcps --no-custom-instructions --no-auto-update \
      --no-ask-user --model claude-sonnet-5 --max-ai-credits 30 \
      > "$results/response.txt"
    ;;
  codex)
    codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox \
      --model gpt-5.4 --output-last-message "$results/response.txt" "$prompt"
    ;;
  claude)
    claude --print --dangerously-skip-permissions --model claude-haiku-4-5 \
      --max-turns 5 --output-format text "$prompt" > "$results/response.txt"
    ;;
  *) echo "Unknown agent: $agent" >&2; exit 1 ;;
esac
test -f "$results/agent-proof.txt" || fail 'Agent did not write the workspace proof'
test "$(cat "$results/agent-proof.txt")" = "$marker" || fail 'Agent wrote an incorrect workspace proof'
grep -Fxq "$marker" "$results/response.txt" || fail 'Inference response did not contain the exact marker'
echo AWF-REGRESSION-COMPLETE
