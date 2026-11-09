#!/usr/bin/env bash
set -euo pipefail
umask 077

root="${GITHUB_WORKSPACE:?}"
agent="${AGENT:?}"
sha="${SOURCE_SHA:?}"
case "$agent" in
  copilot) test -n "${COPILOT_GITHUB_TOKEN:-}" || { echo 'Missing Copilot credential' >&2; exit 1; } ;;
  claude) test -n "${ANTHROPIC_API_KEY:-}" || { echo 'Missing Claude credential' >&2; exit 1; } ;;
  codex) test -n "${OPENAI_API_KEY:-}" || { echo 'Missing Codex credential' >&2; exit 1; } ;;
  *) echo 'Unknown agent' >&2; exit 1 ;;
esac
test "$(git -C "$root" rev-parse HEAD)" = "$sha"
private="${RUNNER_TEMP:?}/reflect-private-$agent"
published="${RUNNER_TEMP}/reflect-evidence-$agent"
mkdir -m 700 "$private" "$published"
printf '%s\n' "$sha" > "$published/source-sha.txt"
for image in agent squid api-proxy fixture; do
  docker image inspect --format '{{.Id}}' "awf-reflect/$image:$sha" >> "$published/image-ids.txt"
done
fixture=''
compose=''
cleanup() {
  result=$?
  if [ -n "$fixture" ]; then
    docker rm --force "$fixture" > /dev/null || result=1
  fi
  if [ -n "$compose" ]; then
    sudo docker compose --file "$compose" down -v -t 1 > "$trusted/cleanup.log" 2>&1 || result=1
  fi
  printf '{"exitCode":%s}\n' "$result" > "$published/harness-status.json"
  exit "$result"
}
trap cleanup EXIT
overall=0
for scenario in recover deny; do
  guest="$private/guest-$scenario"
  trusted="$private/trusted-$scenario"
  mkdir -m 700 "$guest" "$trusted"
  # Only this small workspace is mounted into AWF, not the checkout or grading state.
  cp "$root/scripts/ci/reflect-smoke/guest.sh" "$guest/guest.sh"
  cp -R "$root/.awf-reflect-tools" "$guest/tools"
  printf '{"apiProxy":{"maxTurns":24}}\n' > "$trusted/awf.json"
  fixture="awf-reflect-$agent-$scenario-${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}"
  docker run --detach --name "$fixture" --network none \
    --read-only --cap-drop ALL --security-opt no-new-privileges \
    --tmpfs /evidence:rw,noexec,nosuid,size=2m,mode=1777 \
    --tmpfs /tmp:rw,noexec,nosuid,size=4m \
    --env "SCENARIO=$scenario" "awf-reflect/fixture:$sha" > /dev/null
  ready=0
  for attempt in $(seq 1 30); do
    if docker exec "$fixture" node -e "require('fs').accessSync('/evidence/task.json')" > /dev/null 2>&1; then
      ready=1
      break
    fi
    test "$(docker inspect --format '{{.State.Running}}' "$fixture")" = true
    sleep 1
  done
  test "$ready" = 1
  docker cp "$fixture:/evidence/task.json" "$guest/task.json"
  compose="$trusted/awf/docker-compose.yml"
  status=0
  (
    cd "$guest"
    export GITHUB_WORKSPACE="$guest"
    sudo --preserve-env=COPILOT_GITHUB_TOKEN,OPENAI_API_KEY,ANTHROPIC_API_KEY,GITHUB_ACTIONS,RUNNER_ENVIRONMENT,ImageOS,RUNNER_TOOL_CACHE,AGENT_TOOLSDIRECTORY,RUNNER_TEMP,GITHUB_WORKSPACE \
      timeout --signal=TERM --kill-after=30s 480s \
      "$(command -v node)" "$root/dist/cli.js" \
      --config "$trusted/awf.json" \
      --work-dir "$trusted/awf" --keep-containers \
      --image-registry awf-reflect --image-tag "$sha" --skip-pull \
      --network-isolation --topology-attach "$fixture" --enable-api-proxy \
      --agent-timeout 6 --max-ai-credits 30 --max-permission-denied 1 \
      --rate-limit-rpm 12 --rate-limit-rph 30 --rate-limit-bytes-pm 1048576 \
      --allow-domains 'github.com,githubusercontent.com,githubcopilot.com,api.openai.com,api.anthropic.com' \
      --env "PATH=$guest/tools/node_modules/.bin:$PATH" \
      --container-workdir "$guest" \
      --proxy-logs-dir "$trusted/proxy-logs" \
      -- bash "$guest/guest.sh" "$agent" "http://$fixture:8080"
  ) > "$trusted/agent.log" 2>&1 || status=$?
  # Freeze the trusted fixture before copying evidence; it exposes no grading API.
  docker stop --time 15 "$fixture" > /dev/null
  docker cp "$fixture:/evidence/evidence.json" "$trusted/evidence.json"
  docker rm "$fixture" > /dev/null
  fixture=''
  # Remove the external peer before Compose tears down its network.
  sudo docker compose --file "$compose" down -v -t 1 > "$trusted/cleanup.log" 2>&1 || overall=1
  compose=''
  node "$root/scripts/ci/reflect-smoke/collect.cjs" "$trusted/evidence.json" \
    "$guest/report.json" "$status" "$published/$scenario.json" || overall=1
  # Version is agent-controlled text: publish no arbitrary strings from the guest.
  node "$root/scripts/ci/reflect-smoke/collect.cjs" --version \
    "$guest/agent-version.txt" "$published/agent-version.txt" || overall=1
done
printf '### %s /reflect utilization smoke\n\nSource: `%s`\n\nLive acceptance: %s\n' \
  "$agent" "$sha" "$([ "$overall" = 0 ] && echo PASS || echo FAIL)" >> "${GITHUB_STEP_SUMMARY:?}"
exit "$overall"
