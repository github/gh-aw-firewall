#!/bin/bash
# copilot-pre-exec-check.sh
# Pre-execution validation for GitHub Copilot with API proxy
# Validates that environment is correctly configured before running Copilot CLI
#
# Usage: Run this before executing Copilot CLI commands
# Returns: 0 if checks pass, 1 if checks fail (should prevent execution)

set -e

echo "[copilot-check] GitHub Copilot Pre-Execution Validation"
echo "[copilot-check] =================================================="

# Check if COPILOT_API_URL is set
if [ -z "$COPILOT_API_URL" ]; then
  echo "[copilot-check][ERROR] COPILOT_API_URL is not set!"
  echo "[copilot-check][ERROR] API proxy may not be enabled or configured"
  exit 1
fi
echo "[copilot-check] ✓ COPILOT_API_URL is set: $COPILOT_API_URL"

# Check if COPILOT_GITHUB_TOKEN is set to placeholder
if [ -z "$COPILOT_GITHUB_TOKEN" ]; then
  echo "[copilot-check][ERROR] COPILOT_GITHUB_TOKEN is not set!"
  echo "[copilot-check][ERROR] Expected placeholder value for credential isolation"
  exit 1
fi

if [ "$COPILOT_GITHUB_TOKEN" != "placeholder-token-for-credential-isolation" ]; then
  echo "[copilot-check][ERROR] COPILOT_GITHUB_TOKEN is not set to placeholder value!"
  echo "[copilot-check][ERROR] Current value starts with: ${COPILOT_GITHUB_TOKEN:0:5}..."
  echo "[copilot-check][ERROR] Expected: placeholder-token-for-credential-isolation"
  echo "[copilot-check][ERROR] Real token detected - credential isolation failed"
  exit 1
fi
echo "[copilot-check] ✓ COPILOT_GITHUB_TOKEN is placeholder value (correct)"

# Test connectivity to COPILOT_API_URL
echo "[copilot-check] Testing connectivity to $COPILOT_API_URL..."

# Extract host and port from API URL (format: http://IP:PORT)
PROXY_HOST=$(echo "$COPILOT_API_URL" | sed -E 's|^https?://([^:]+):.*|\1|')
PROXY_PORT=$(echo "$COPILOT_API_URL" | sed -E 's|^https?://[^:]+:([0-9]+).*|\1|')

# Test TCP connectivity with timeout
if timeout 5 bash -c "cat < /dev/null > /dev/tcp/$PROXY_HOST/$PROXY_PORT" 2>/dev/null; then
  echo "[copilot-check] ✓ GitHub Copilot API proxy is reachable"
else
  echo "[copilot-check][ERROR] Cannot connect to GitHub Copilot API proxy at $COPILOT_API_URL"
  echo "[copilot-check][ERROR] Proxy may not be running or network is blocked"
  exit 1
fi

echo "[copilot-check] =================================================="
echo "[copilot-check] ✓ All pre-execution checks passed"
echo "[copilot-check] ✓ Ready to run GitHub Copilot CLI"
echo "[copilot-check] =================================================="
