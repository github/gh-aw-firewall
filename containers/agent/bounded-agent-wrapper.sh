#!/bin/sh
# /usr/local/bin/bounded-agent
#
# Agent-facing bounded-agent CLI (protocol v1).
#
# Forwards a *narrow* request to the trusted bounded-agent broker over the
# Compose Unix socket. Like bounded-query-wrapper.sh, the API is deliberately
# far narrower than a general tool: this wrapper cannot express a command, an
# image, an executable, a path, a URL, a ref, a mount, an environment variable,
# an endpoint, a network, a proxy, a credential, a runtime, a timeout, a
# resource limit, a model, a provider, a system prompt, or a tool definition.
# It accepts exactly:
#
#   --repo owner/repo        (exactly once)
#   --schema '<json>'        (exactly once; a finite response schema, see
#                             src/bounded-execution/finite-disclosure.ts)
#   the bounded task text on stdin
#
# Output contract: exactly one line of canonical JSON on stdout, nothing on
# stderr, and exit status 0 — for every outcome and for every failure.
# Transport, framing, and validation failures all produce the same local
# {"status":"error"} so the agent cannot distinguish them by exit status. The
# remaining information budget is never disclosed.
#
# Dependencies: curl, base64 (both already required/available in the agent
# image).

CANONICAL_ERROR='{"status":"error"}'
SOCKET="${AWF_BOUNDED_AGENT_SOCKET:-}"
PROTOCOL_VERSION=1
# Keep in sync with MAX_SCHEMA_BYTES in src/bounded-execution/finite-disclosure.ts
# and containers/bounded-query/bounded-execution/finite-disclosure.js.
MAX_SCHEMA_BYTES=4096

emit_error() {
  printf '%s\n' "$CANONICAL_ERROR"
  exit 0
}

REPO=""
SCHEMA=""
HAVE_REPO=0
HAVE_SCHEMA=0

while [ $# -gt 0 ]; do
  case "$1" in
    --repo)
      [ $# -ge 2 ] || emit_error
      [ "$HAVE_REPO" -eq 0 ] || emit_error
      REPO="$2"
      HAVE_REPO=1
      shift 2
      ;;
    --schema)
      [ $# -ge 2 ] || emit_error
      [ "$HAVE_SCHEMA" -eq 0 ] || emit_error
      SCHEMA="$2"
      HAVE_SCHEMA=1
      shift 2
      ;;
    *)
      # Any other flag, any `--flag=value` form, and any positional argument
      # is an unsupported control.
      emit_error
      ;;
  esac
done

[ "$HAVE_REPO" -eq 1 ] || emit_error
[ "$HAVE_SCHEMA" -eq 1 ] || emit_error

printf '%s' "$REPO" | LC_ALL=C grep -Eq '^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$' || emit_error
case "$REPO" in
  *..* ) emit_error ;;
esac

[ -n "$SCHEMA" ] || emit_error
[ "$(printf '%s' "$SCHEMA" | wc -c)" -le "$MAX_SCHEMA_BYTES" ] || emit_error

# base64url, no padding: standard base64 with `+/` -> `-_`, `=` stripped, and
# newlines removed (wrapping width varies across base64 implementations).
SCHEMA_B64=$(printf '%s' "$SCHEMA" | base64 | tr -d '\n' | tr '+/' '-_' | tr -d '=') || emit_error

# The task must arrive on stdin; an interactive terminal means no task.
[ ! -t 0 ] || emit_error

[ -n "$SOCKET" ] || emit_error
[ -S "$SOCKET" ] || emit_error

RESPONSE=$(
  curl --silent --show-error \
    --noproxy '*' \
    --unix-socket "$SOCKET" \
    --max-time 660 \
    -X POST \
    -H "Expect:" \
    -H "Content-Type: application/octet-stream" \
    -H "X-AWF-Agent-Version: ${PROTOCOL_VERSION}" \
    -H "X-AWF-Repo: ${REPO}" \
    -H "X-AWF-Schema-B64: ${SCHEMA_B64}" \
    --data-binary @- \
    "http://localhost/query" 2>/dev/null
) || emit_error

# Pass the broker's canonical response through unmodified, but only if it has
# one of the two shapes the protocol ever produces. Anything else (a dead or
# misbehaving broker, a transport-level fragment) is treated as a failure
# rather than forwarded verbatim.
case "$RESPONSE" in
  '{"status":"error"}')
    printf '%s\n' "$RESPONSE"
    exit 0
    ;;
  '{"status":"ok","result":'*'}')
    printf '%s\n' "$RESPONSE"
    exit 0
    ;;
  *)
    emit_error
    ;;
esac
