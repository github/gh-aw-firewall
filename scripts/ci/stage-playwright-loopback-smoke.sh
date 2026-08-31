#!/usr/bin/env bash
set -euo pipefail

MICROSOFT_NPM_REGISTRY='https://packagefeedproxy.microsoft.io/npm/'
PLAYWRIGHT_CLI_VERSION='0.1.18'
PLAYWRIGHT_ROOT='/tmp/gh-aw/playwright'
PLAYWRIGHT_CLI_ROOT="${PLAYWRIGHT_ROOT}/cli"
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_ROOT}/browsers"

mkdir -p "$PLAYWRIGHT_CLI_ROOT" "$PLAYWRIGHT_BROWSERS_PATH"

resolved_version="$(npm view \
  --registry "$MICROSOFT_NPM_REGISTRY" \
  "@playwright/cli@${PLAYWRIGHT_CLI_VERSION}" \
  version)"
if [[ "$resolved_version" != "$PLAYWRIGHT_CLI_VERSION" ]]; then
  echo "Expected @playwright/cli ${PLAYWRIGHT_CLI_VERSION} from the Microsoft registry, got ${resolved_version}" >&2
  exit 1
fi

npm install \
  --prefix "$PLAYWRIGHT_CLI_ROOT" \
  --registry "$MICROSOFT_NPM_REGISTRY" \
  --ignore-scripts \
  --no-audit \
  --no-fund \
  "@playwright/cli@${PLAYWRIGHT_CLI_VERSION}"

PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_BROWSERS_PATH" \
  "${PLAYWRIGHT_CLI_ROOT}/node_modules/.bin/playwright-cli" install-browser chromium

