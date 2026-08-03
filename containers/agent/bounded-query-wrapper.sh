#!/bin/sh
# /usr/local/bin/bounded-query
#
# Agent-facing bounded-query CLI (protocol v2).
#
# Forwards a *narrow* request to the trusted bounded-query broker over either
# the Compose Unix socket or the authenticated sbx HTTP ingress. It is
# analogous to gh-cli-proxy-wrapper.sh, but the
# API is deliberately far narrower: this wrapper cannot express a command, an
# image, a path, a URL, a ref, a mount, a runtime, a timeout, an environment,
# or a credential. It accepts exactly:
#
#   --repo owner/repo        (exactly once)
#   --schema '<json>'        (exactly once; a finite response schema, see
#                             src/bounded-execution/finite-disclosure.ts)
#   the query script on stdin
#
# Output contract: exactly one line of canonical JSON on stdout, nothing on
# stderr, and exit status 0 — for every outcome and for every failure.
# Transport, framing, and validation failures all produce the same local
# {"status":"error"} so the agent cannot distinguish them by exit status.
#
# The wrapper does not (and cannot, in POSIX sh) validate the schema's
# structure, cardinality, or information-budget charge — that is the trusted
# broker's job, enforced *before* it copies a seed or launches Python. The
# wrapper's only responsibilities are: enforce the fixed CLI shape, transport
# the request unmodified, and pass the broker's response through unmodified.
#
# Dependencies: curl, base64 (both already required/available in the agent
# image).

CANONICAL_ERROR='{"status":"error"}'
SOCKET="${AWF_BOUNDED_QUERY_SOCKET:-}"
ENDPOINT="${AWF_BOUNDED_QUERY_ENDPOINT:-}"
CAPABILITY="${AWF_BOUNDED_QUERY_CAPABILITY:-}"
PROTOCOL_VERSION=2
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

# The script must arrive on stdin; an interactive terminal means no script.
[ ! -t 0 ] || emit_error

if [ -n "$SOCKET" ] && [ -z "$ENDPOINT" ] && [ -z "$CAPABILITY" ]; then
  [ -S "$SOCKET" ] || emit_error
  RESPONSE=$(
    curl --silent --show-error \
      --noproxy '*' \
      --unix-socket "$SOCKET" \
      --max-time 660 \
      -X POST \
      -H "Expect:" \
      -H "Content-Type: application/octet-stream" \
      -H "X-AWF-Query-Version: ${PROTOCOL_VERSION}" \
      -H "X-AWF-Repo: ${REPO}" \
      -H "X-AWF-Schema-B64: ${SCHEMA_B64}" \
      --data-binary @- \
      "http://localhost/query" 2>/dev/null
  ) || emit_error
elif [ -z "$SOCKET" ] && [ -n "$ENDPOINT" ] && [ -n "$CAPABILITY" ]; then
  case "$ENDPOINT" in
    http://host.docker.internal:*/query)
      PORT="${ENDPOINT#http://host.docker.internal:}"
      PORT="${PORT%/query}"
      printf '%s' "$PORT" | LC_ALL=C grep -Eq '^[0-9]{1,5}$' || emit_error
      [ "$PORT" -ge 1 ] 2>/dev/null || emit_error
      [ "$PORT" -le 65535 ] 2>/dev/null || emit_error
      ;;
    *) emit_error ;;
  esac
  printf '%s' "$CAPABILITY" | LC_ALL=C grep -Eq '^[0-9a-f]{64}$' || emit_error
  RESPONSE=$(
    curl --silent --show-error \
      --noproxy '*' \
      --max-time 660 \
      -X POST \
      -H "Expect:" \
      -H "Content-Type: application/octet-stream" \
      -H "X-AWF-Capability: ${CAPABILITY}" \
      -H "X-AWF-Query-Version: ${PROTOCOL_VERSION}" \
      -H "X-AWF-Repo: ${REPO}" \
      -H "X-AWF-Schema-B64: ${SCHEMA_B64}" \
      --data-binary @- \
      "$ENDPOINT" 2>/dev/null
  ) || emit_error
else
  emit_error
fi

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
