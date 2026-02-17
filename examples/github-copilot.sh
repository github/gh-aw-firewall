#!/bin/bash
# Example: Using GitHub Copilot CLI with the firewall and API proxy
#
# This example shows how to run GitHub Copilot CLI through the firewall
# with credential isolation via the API proxy sidecar.
#
# Prerequisites:
# - GitHub Copilot CLI installed: npm install -g @github/copilot
# - COPILOT_API_KEY environment variable set (for API proxy)
# - GITHUB_TOKEN environment variable set (for GitHub API access)
#
# Usage: sudo -E ./examples/github-copilot.sh

set -e

echo "=== AWF GitHub Copilot CLI Example (with API Proxy) ==="
echo ""

# Check for COPILOT_API_KEY
if [ -z "$COPILOT_API_KEY" ]; then
  echo "Error: COPILOT_API_KEY environment variable is not set"
  echo "Set it with: export COPILOT_API_KEY='your_copilot_api_key'"
  exit 1
fi

# Check for GITHUB_TOKEN
if [ -z "$GITHUB_TOKEN" ]; then
  echo "Error: GITHUB_TOKEN environment variable is not set"
  echo "Set it with: export GITHUB_TOKEN='your_token'"
  exit 1
fi

# Enable one-shot-token debug logging
export AWF_ONE_SHOT_TOKEN_DEBUG=1

echo "Running GitHub Copilot CLI with API proxy and debug logging enabled..."
echo ""

# Run Copilot CLI with API proxy enabled
# Use sudo -E to preserve environment variables (COPILOT_API_KEY, GITHUB_TOKEN, AWF_ONE_SHOT_TOKEN_DEBUG)
# Required domains:
# - api.githubcopilot.com: Copilot API endpoint (proxied via api-proxy)
# - github.com: GitHub API access
# - api.github.com: GitHub REST API
# - registry.npmjs.org: NPM package registry (for npx)
sudo -E awf \
  --enable-api-proxy \
  --allow-domains api.githubcopilot.com,github.com,api.github.com,registry.npmjs.org \
  --log-level debug \
  -- 'npx @github/copilot --prompt "What is 2+2?" --no-mcp'

echo ""
echo "=== Example Complete ==="
