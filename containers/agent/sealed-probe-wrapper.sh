#!/bin/sh
# /usr/local/bin/sealed-probe
#
# Agent-facing sealed-probe CLI.
#
# Forwards a *narrow* request to the trusted sealed-probe broker over a
# dedicated Unix socket. It is analogous to gh-cli-proxy-wrapper.sh, but the
# API is deliberately far narrower: this wrapper cannot express a command, an
# image, a path, a URL, a ref, a mount, a runtime, a timeout, an environment,
# or a credential. It accepts exactly:
#
#   --repo owner/repo        (exactly once)
#   --outcome LABEL          (exactly three times)
#   the probe script on stdin
#
# Output contract: exactly one line of canonical JSON on stdout, nothing on
# stderr, and exit status 0 — for every outcome and for every failure.
# Transport, framing, and validation failures all produce the same local
# {"result":"ERROR"} so the agent cannot distinguish them.
#
# Dependencies: curl (also required by the existing gh wrapper).

CANONICAL_ERROR='{"result":"ERROR"}'
SOCKET="${AWF_SEALED_PROBE_SOCKET:-/run/awf-sealed-probe/broker.sock}"
PROTOCOL_VERSION=1
MAX_OUTCOME_BYTES=64

emit_error() {
  printf '%s\n' "$CANONICAL_ERROR"
  exit 0
}

# Rejects anything that is not a bounded ASCII enum identifier.
# Mirrors (and is re-enforced by) the broker's protocol validation.
valid_outcome() {
  [ -n "$1" ] || return 1
  [ "$1" != "ERROR" ] || return 1
  [ "$(printf '%s' "$1" | wc -c)" -le "$MAX_OUTCOME_BYTES" ] || return 1
  printf '%s' "$1" | LC_ALL=C grep -Eq '^[A-Za-z][A-Za-z0-9_-]{0,63}$' || return 1
  return 0
}

REPO=""
OUTCOME_1=""
OUTCOME_2=""
OUTCOME_3=""
OUTCOME_COUNT=0

while [ $# -gt 0 ]; do
  case "$1" in
    --repo)
      [ $# -ge 2 ] || emit_error
      [ -z "$REPO" ] || emit_error
      REPO="$2"
      shift 2
      ;;
    --outcome)
      [ $# -ge 2 ] || emit_error
      OUTCOME_COUNT=$((OUTCOME_COUNT + 1))
      case "$OUTCOME_COUNT" in
        1) OUTCOME_1="$2" ;;
        2) OUTCOME_2="$2" ;;
        3) OUTCOME_3="$2" ;;
        *) emit_error ;;
      esac
      shift 2
      ;;
    *)
      # Any other flag, any `--flag=value` form, and any positional argument
      # is an unsupported control.
      emit_error
      ;;
  esac
done

[ -n "$REPO" ] || emit_error
[ "$OUTCOME_COUNT" -eq 3 ] || emit_error

printf '%s' "$REPO" | LC_ALL=C grep -Eq '^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$' || emit_error
case "$REPO" in
  *..* ) emit_error ;;
esac

valid_outcome "$OUTCOME_1" || emit_error
valid_outcome "$OUTCOME_2" || emit_error
valid_outcome "$OUTCOME_3" || emit_error

[ "$OUTCOME_1" != "$OUTCOME_2" ] || emit_error
[ "$OUTCOME_1" != "$OUTCOME_3" ] || emit_error
[ "$OUTCOME_2" != "$OUTCOME_3" ] || emit_error

# The script must arrive on stdin; an interactive terminal means no script.
[ ! -t 0 ] || emit_error

[ -S "$SOCKET" ] || emit_error

# --noproxy '*' keeps HTTP(S)_PROXY from redirecting a Unix-socket request.
# --max-time bounds the wait at the schema's maximum probe timeout plus slack;
# the broker always answers, so this only guards a dead socket.
RESPONSE=$(
  curl --silent --show-error \
    --noproxy '*' \
    --unix-socket "$SOCKET" \
    --max-time 3900 \
    -X POST \
    -H "Expect:" \
    -H "Content-Type: application/octet-stream" \
    -H "X-AWF-Probe-Version: ${PROTOCOL_VERSION}" \
    -H "X-AWF-Repo: ${REPO}" \
    -H "X-AWF-Outcome-1: ${OUTCOME_1}" \
    -H "X-AWF-Outcome-2: ${OUTCOME_2}" \
    -H "X-AWF-Outcome-3: ${OUTCOME_3}" \
    --data-binary @- \
    "http://localhost/probe" 2>/dev/null
) || emit_error

# Only the canonical serialization of a declared outcome (or the reserved
# ERROR sentinel) is ever printed. Anything else is treated as a failure.
for expected in "$OUTCOME_1" "$OUTCOME_2" "$OUTCOME_3" "ERROR"; do
  if [ "$RESPONSE" = "{\"result\":\"${expected}\"}" ]; then
    printf '%s\n' "$RESPONSE"
    exit 0
  fi
done

emit_error
