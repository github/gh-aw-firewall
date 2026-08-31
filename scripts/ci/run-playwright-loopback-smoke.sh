#!/usr/bin/env bash
set -Eeuo pipefail

RESULT_DIR=/tmp/gh-aw/agent/playwright-loopback
RESULT_FILE=/tmp/gh-aw/agent/playwright-loopback-results.json
SERVER_SCRIPT="$RESULT_DIR/server.mjs"
SERVER_LOG="$RESULT_DIR/server.log"
PORT_FILE="$RESULT_DIR/port"
PLAYWRIGHT_CONFIG="$RESULT_DIR/cli.config.json"
PLAYWRIGHT_LOG="$RESULT_DIR/playwright.log"
BLOCKED_LOG="$RESULT_DIR/blocked-egress.log"
SERVER_PID=
EXPECTED_RUNTIME="${1:?usage: run-playwright-loopback-smoke.sh <runtime>}"
PLAYWRIGHT_ROOT=/tmp/gh-aw/playwright
PLAYWRIGHT_CLI_ROOT="$PLAYWRIGHT_ROOT/cli"
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$PLAYWRIGHT_ROOT/browsers}"

export PATH="$PLAYWRIGHT_CLI_ROOT/node_modules/.bin:$PATH"
export PLAYWRIGHT_BROWSERS_PATH

mkdir -p "$RESULT_DIR"
: > "$SERVER_LOG"
: > "$PLAYWRIGHT_LOG"
: > "$BLOCKED_LOG"
rm -f "$PORT_FILE" "$RESULT_FILE"

cleanup() {
  playwright-cli close >/dev/null 2>&1 || true
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID"
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if ! command -v playwright-cli >/dev/null 2>&1; then
  echo "Pre-staged playwright-cli is not available inside the agent sandbox" >&2
  exit 1
fi

if [ ! -d "$PLAYWRIGHT_BROWSERS_PATH" ]; then
  echo "Pre-staged Playwright browser directory is not available inside the agent sandbox" >&2
  exit 1
fi

PROXY_URL="${HTTPS_PROXY:-${https_proxy:-}}"
if [ -z "$PROXY_URL" ]; then
  echo "HTTPS_PROXY is not configured inside the agent sandbox" >&2
  exit 1
fi

TITLE="awf-playwright-$(node -e 'process.stdout.write(require("crypto").randomBytes(12).toString("hex"))')"
export AWF_PLAYWRIGHT_SMOKE_TITLE="$TITLE"
export AWF_PLAYWRIGHT_SMOKE_PORT_FILE="$PORT_FILE"
export PLAYWRIGHT_CLI_SESSION="awf-loopback-${GITHUB_RUN_ID:-$$}"

cat > "$SERVER_SCRIPT" <<'NODE'
import http from "node:http";
import fs from "node:fs";

const title = process.env.AWF_PLAYWRIGHT_SMOKE_TITLE;
const portFile = process.env.AWF_PLAYWRIGHT_SMOKE_PORT_FILE;
const page = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <script>
      fetch("/title")
        .then(response => response.json())
        .then(payload => { document.title = payload.title; });
    </script>
  </head>
  <body>AWF Playwright loopback smoke test</body>
</html>`;

const server = http.createServer((request, response) => {
  if (request.url === "/title") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ title }));
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(page);
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not determine loopback server port");
  }
  fs.writeFileSync(portFile, String(address.port), { mode: 0o600 });
});
NODE

node - "$PLAYWRIGHT_CONFIG" "$PROXY_URL" "$RESULT_DIR" <<'NODE'
const fs = require("node:fs");

fs.writeFileSync(process.argv[2], JSON.stringify({
  browser: {
    isolated: true,
    launchOptions: {
      headless: true,
      proxy: {
        server: process.argv[3],
        bypass: "localhost,127.0.0.1",
      },
    },
  },
  outputDir: process.argv[4],
  outputMode: "stdout",
}, null, 2), { mode: 0o600 });
NODE

node "$SERVER_SCRIPT" >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 30); do
  if [ -s "$PORT_FILE" ]; then
    PORT=$(cat "$PORT_FILE")
    if curl --fail --silent --show-error --max-time 1 "http://127.0.0.1:$PORT/" >/dev/null; then
      break
    fi
  fi
  sleep 1
done

if [ ! -s "$PORT_FILE" ]; then
  echo "Loopback server did not publish a port" >&2
  exit 1
fi

PORT=$(cat "$PORT_FILE")
URL="http://127.0.0.1:$PORT/"
curl --fail --silent --show-error --max-time 2 "$URL" >/dev/null
playwright-cli open --config "$PLAYWRIGHT_CONFIG" "$URL" >>"$PLAYWRIGHT_LOG" 2>&1

TITLE_OBSERVED=false
for _ in $(seq 1 20); do
  if TITLE_MATCH=$(playwright-cli --raw eval \
      "() => document.title === '$TITLE'" 2>>"$PLAYWRIGHT_LOG"); then
    printf '%s\n' "$TITLE_MATCH" >>"$PLAYWRIGHT_LOG"
    if [ "$TITLE_MATCH" = true ]; then
      TITLE_OBSERVED=true
      break
    fi
  fi
  sleep 1
done

if [ "$TITLE_OBSERVED" != true ]; then
  echo "Playwright did not observe the JavaScript-generated title" >&2
  exit 1
fi

set +e
playwright-cli goto https://example.com \
  >"$BLOCKED_LOG" 2>&1
BLOCKED_EXIT=$?
set -e
if [ "$BLOCKED_EXIT" -eq 0 ]; then
  echo "Playwright unexpectedly reached non-allowlisted example.com" >&2
  exit 1
fi

cat > "$RESULT_FILE" <<EOF
{
  "runtime": "$EXPECTED_RUNTIME",
  "loopback": "PASS",
  "javascript_title": "PASS",
  "blocked_egress": "PASS",
  "url": "$URL"
}
EOF

cat "$RESULT_FILE"
