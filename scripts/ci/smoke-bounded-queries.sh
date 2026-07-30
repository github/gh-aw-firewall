#!/usr/bin/env bash

set -euo pipefail

readonly TARGET_REPO="github/gh-aw"
readonly ARRAY_SCHEMA='{"type":"array","items":{"type":"boolean"},"length":28}'
readonly BOOLEAN_SCHEMA='{"type":"boolean"}'

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

  local schema expected_sequence result_kind
  case "${SMOKE_SENSITIVITY:-}" in
    public)
      # The array admits 2^28 results, so each invocation costs 32 bits.
      # Public must remain unmetered even after three invocations (96 bits).
      schema="$ARRAY_SCHEMA"
      expected_sequence="ok ok ok"
      result_kind="array"
      ;;
    internal)
      # Two 32-bit invocations exactly exhaust the 64-bit internal budget.
      schema="$ARRAY_SCHEMA"
      expected_sequence="ok ok error"
      result_kind="array"
      ;;
    confidential)
      # A boolean costs 5 bits, so only one fits in the 8-bit budget.
      schema="$BOOLEAN_SCHEMA"
      expected_sequence="ok error error"
      result_kind="boolean"
      ;;
    sealed)
      # The zero-bit sealed budget must reject even the first query.
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

  local root
  root="${RUNNER_TEMP:-/tmp}/smoke-bounded-queries-${GITHUB_RUN_ID:-local}"
  mkdir -p "$root"

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
    "runtime": "docker",
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
}

if [[ "${1:-}" == "--inside-agent" ]]; then
  run_inside_agent
else
  run_on_host
fi
