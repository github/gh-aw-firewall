#!/usr/bin/env bash
set -euo pipefail

MICROSOFT_NPM_REGISTRY='https://packagefeedproxy.microsoft.io/npm/'
PLAYWRIGHT_CLI_VERSION='0.1.18'
PLAYWRIGHT_ROOT='/tmp/gh-aw/playwright'
PLAYWRIGHT_CLI_ROOT="${PLAYWRIGHT_ROOT}/cli"
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_ROOT}/browsers"
PLAYWRIGHT_SYSROOT="${PLAYWRIGHT_ROOT}/sysroot"
BUILD_TOOLS_IMAGE='ghcr.io/github/gh-aw-firewall/build-tools@sha256:b2d1b8424592488d0696e7181ce979409526a8c8821518c9ec8c45d676308722'

mkdir -p "$PLAYWRIGHT_CLI_ROOT" "$PLAYWRIGHT_BROWSERS_PATH" "$PLAYWRIGHT_SYSROOT"

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

docker run --rm \
  --mount "type=bind,source=${PLAYWRIGHT_SYSROOT},target=/out" \
  "$BUILD_TOOLS_IMAGE" \
  bash -c '
    set -euo pipefail
    apt-get update >/dev/null
    apt-get install --reinstall --download-only --yes --no-install-recommends \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libatspi2.0-0 \
      libbrotli1 \
      libbsd0 \
      libcairo2 \
      libcups2 \
      libdatrie1 \
      libdbus-1-3 \
      libdrm2 \
      libexpat1 \
      libffi8 \
      libfontconfig1 \
      libfreetype6 \
      libfribidi0 \
      libgbm1 \
      libglib2.0-0 \
      libgraphite2-3 \
      libharfbuzz0b \
      libmd0 \
      libmount1 \
      libnspr4 \
      libnss3 \
      libpango-1.0-0 \
      libpcre3 \
      libpixman-1-0 \
      libpng16-16 \
      libselinux1 \
      libthai0 \
      libuuid1 \
      libx11-6 \
      libxau6 \
      libxcb1 \
      libxcb-render0 \
      libxcb-shm0 \
      libxcomposite1 \
      libxdamage1 \
      libxdmcp6 \
      libxext6 \
      libxfixes3 \
      libxkbcommon0 \
      libxrandr2 \
      libxrender1 \
      zlib1g >/dev/null
    for package in /var/cache/apt/archives/*.deb; do
      dpkg-deb --extract "$package" /out
    done
  '
