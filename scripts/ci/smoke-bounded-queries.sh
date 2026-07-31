#!/usr/bin/env bash

set -euo pipefail

readonly TARGET_REPO="github/gh-aw"
readonly ARRAY_SCHEMA='{"type":"array","items":{"type":"boolean"},"length":28}'
readonly BOOLEAN_SCHEMA='{"type":"boolean"}'
readonly QUERY_RUNTIME="${SMOKE_QUERY_RUNTIME:-docker}"

fail() {
  echo "::error::$*" >&2
  exit 1
}

run_inside_agent() {
  command -v bounded-query >/dev/null || fail "bounded-query is not installed"
  [[ "${AWF_BOUNDED_QUERY_REPOS:-}" == "$TARGET_REPO" ]] ||
    fail "unexpected AWF_BOUNDED_QUERY_REPOS: ${AWF_BOUNDED_QUERY_REPOS:-<unset>}"
  [[ -z "${GH_TOKEN:-}" && -z "${GITHUB_TOKEN:-}" ]] ||
    fail "staging credentials reached the agent environment"
  [[ -n "${AWF_BOUNDED_QUERY_SOCKET:-}" && -S "$AWF_BOUNDED_QUERY_SOCKET" ]] ||
    fail "bounded-query broker socket is unavailable"

  local transport_probe
  transport_probe="$(
    curl --silent --show-error --noproxy '*' \
      --unix-socket "$AWF_BOUNDED_QUERY_SOCKET" \
      --max-time 5 \
      -X POST \
      -H "Expect:" \
      --data-binary '' \
      http://localhost/query
  )" || fail "bounded-query broker socket is not connectable"
  [[ "$transport_probe" == '{"status":"error"}' ]] ||
    fail "bounded-query broker returned a noncanonical transport probe response"

  local schema expected_sequence result_kind
  case "${SMOKE_SENSITIVITY:-}" in
    public)
      schema="$ARRAY_SCHEMA"
      expected_sequence="ok ok ok"
      result_kind="array"
      ;;
    internal)
      schema="$ARRAY_SCHEMA"
      expected_sequence="ok ok error"
      result_kind="array"
      ;;
    confidential)
      schema="$BOOLEAN_SCHEMA"
      expected_sequence="ok error error"
      result_kind="boolean"
      ;;
    sealed)
      schema="$BOOLEAN_SCHEMA"
      expected_sequence="error error error"
      result_kind="boolean"
      ;;
    *)
      fail "unsupported sensitivity: ${SMOKE_SENSITIVITY:-<unset>}"
      ;;
  esac

  local -a expected
  read -r -a expected <<< "$expected_sequence"

  local attempt response actual
  for attempt in 0 1 2; do
    if [[ "$result_kind" == "array" ]]; then
      response="$(
        bounded-query --repo "$TARGET_REPO" --schema "$schema" <<'PY'
import json
from pathlib import Path

go_mod_exists = Path("/query/repo/go.mod").is_file()
Path("/query/out").write_text(json.dumps([go_mod_exists] * 28))
PY
      )"
    else
      response="$(
        bounded-query --repo "$TARGET_REPO" --schema "$schema" <<'PY'
import json
from pathlib import Path

go_mod_exists = Path("/query/repo/go.mod").is_file()
Path("/query/out").write_text(json.dumps(go_mod_exists))
PY
      )"
    fi

    actual="$(
      python3 - "$response" "$result_kind" <<'PY'
import json
import sys

payload = json.loads(sys.argv[1])
result_kind = sys.argv[2]
status = payload.get("status")

if status == "ok":
    result = payload.get("result")
    if result_kind == "boolean" and result is not True:
        raise SystemExit("boolean query did not confirm github/gh-aw/go.mod")
    if result_kind == "array" and result != [True] * 28:
        raise SystemExit("bounded array query did not confirm github/gh-aw/go.mod")
elif status == "error":
    if payload != {"status": "error"}:
        raise SystemExit("error response was not canonical")
else:
    raise SystemExit(f"unexpected bounded-query response: {payload!r}")

print(status)
PY
    )"

    [[ "$actual" == "${expected[$attempt]}" ]] ||
      fail "${SMOKE_SENSITIVITY} attempt $((attempt + 1)): expected ${expected[$attempt]}, got $actual ($response)"
    echo "${SMOKE_SENSITIVITY} attempt $((attempt + 1)): $actual"
  done

  echo "${SMOKE_SENSITIVITY}: PASS"
}

run_on_host() {
  command -v awf >/dev/null || fail "awf is not installed"
  [[ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ]] ||
    fail "GH_TOKEN or GITHUB_TOKEN is required for trusted repository staging"
  [[ "$QUERY_RUNTIME" == "docker" || "$QUERY_RUNTIME" == "gvisor" || "$QUERY_RUNTIME" == "sbx" ]] ||
    fail "unsupported query runtime: $QUERY_RUNTIME"

  local root
  root="${RUNNER_TEMP:-/tmp}/smoke-bounded-queries-${QUERY_RUNTIME}-${GITHUB_RUN_ID:-local}"
  mkdir -p "$root"

  if [[ "${SMOKE_EXPECT_BLOCKED:-false}" == "true" ]]; then
    [[ "$QUERY_RUNTIME" == "sbx" ]] ||
      fail "expected-blocked smoke is only valid for the sbx query runtime"
    local blocked_config blocked_log blocked_status
    blocked_config="$root/blocked.json"
    blocked_log="$root/blocked.log"
    cat > "$blocked_config" <<JSON
{
  "network": {
    "isolation": true
  },
  "boundedQueries": {
    "enabled": true,
    "privateRepos": [
      {
        "repo": "$TARGET_REPO",
        "sensitivity": "internal"
      }
    ],
    "runtime": "$QUERY_RUNTIME",
    "timeout": 30,
    "memoryLimit": "2g",
    "interpreter": "python3",
    "maxInvocations": 10
  }
}
JSON

    set +e
    awf \
      --build-local \
      --config "$blocked_config" \
      --work-dir "$root/blocked-work" \
      --container-workdir "${GITHUB_WORKSPACE:-$(pwd)}" \
      -- true >"$blocked_log" 2>&1
    blocked_status=$?
    set -e

    [[ "$blocked_status" -ne 0 ]] ||
      fail "$QUERY_RUNTIME unexpectedly passed mandatory bounded-query preflight"
    grep -F 'boundedQueries.runtime "sbx" is blocked' "$blocked_log" >/dev/null ||
      fail "$QUERY_RUNTIME did not report the expected security block"
    grep -F 'AWF will not launch a query VM and will never fall back to Docker or gVisor' "$blocked_log" >/dev/null ||
      fail "$QUERY_RUNTIME did not confirm that fallback is disabled"
    echo "$QUERY_RUNTIME: expected fail-closed preflight PASS"
    return
  fi

  local sensitivity config work_dir audit_dir audit_log workspace
  workspace="${GITHUB_WORKSPACE:-$(pwd)}"
  for sensitivity in public internal confidential sealed; do
    config="$root/$sensitivity.json"
    work_dir="$root/$sensitivity-work"
    audit_dir="$root/$sensitivity-audit"

    cat > "$config" <<JSON
{
  "network": {
    "isolation": true
  },
  "logging": {
    "auditDir": "$audit_dir"
  },
  "boundedQueries": {
    "enabled": true,
    "privateRepos": [
      {
        "repo": "$TARGET_REPO",
        "sensitivity": "$sensitivity"
      }
    ],
    "runtime": "$QUERY_RUNTIME",
    "timeout": 30,
    "memoryLimit": "2g",
    "interpreter": "python3",
    "maxInvocations": 10
  }
}
JSON

    echo "::group::bounded queries: $sensitivity"
    if ! awf \
        --build-local \
        --config "$config" \
        --work-dir "$work_dir" \
        --container-workdir "$workspace" \
        --env "SMOKE_SENSITIVITY=$sensitivity" \
        -- bash "$workspace/scripts/ci/smoke-bounded-queries.sh" --inside-agent; then
      audit_log="$audit_dir/bounded-query.jsonl"
      if [[ -f "$audit_log" ]]; then
        echo "::group::bounded query broker audit"
        sudo cat "$audit_log"
        echo "::endgroup::"
      fi
      fail "$sensitivity bounded-query run failed"
    fi
    echo "::endgroup::"
  done

  node "$workspace/scripts/ci/report-bounded-query-runtime-matrix.js" --require "docker/$QUERY_RUNTIME"
}

if [[ "${1:-}" == "--inside-agent" ]]; then
  run_inside_agent
else
  run_on_host
fi
