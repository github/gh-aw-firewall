#!/bin/bash
# api-proxy-health-check.sh
# Pre-flight health check to verify API proxy credential isolation
# This script ensures:
# 1. API keys are NOT present in agent environment (credential isolation working)
# 2. API proxy is reachable and healthy (connectivity established)
#
# Usage: source this script before running agent commands
# Returns: 0 if checks pass, 1 if checks fail (prevents agent from running)

set -e

echo "[health-check] API Proxy Pre-flight Check"
echo "[health-check] =========================================="

# Track if any API proxy is configured
API_PROXY_CONFIGURED=false

# Check Claude/Anthropic configuration
if [ -n "$ANTHROPIC_BASE_URL" ]; then
  API_PROXY_CONFIGURED=true
  echo "[health-check] Checking Anthropic API proxy configuration..."

  # Verify credentials are NOT in agent environment
  if [ -n "$ANTHROPIC_API_KEY" ] || [ -n "$CLAUDE_API_KEY" ]; then
    echo "[health-check][ERROR] Anthropic API key found in agent environment!"
    echo "[health-check][ERROR] Credential isolation failed - keys should only be in api-proxy container"
    echo "[health-check][ERROR] ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:+<present>}"
    echo "[health-check][ERROR] CLAUDE_API_KEY=${CLAUDE_API_KEY:+<present>}"
    exit 1
  fi
  echo "[health-check] ✓ Anthropic credentials NOT in agent environment (correct)"

  # Verify ANTHROPIC_AUTH_TOKEN is placeholder (if present)
  if [ -n "$ANTHROPIC_AUTH_TOKEN" ]; then
    if [ "$ANTHROPIC_AUTH_TOKEN" != "placeholder-token-for-credential-isolation" ]; then
      echo "[health-check][ERROR] ANTHROPIC_AUTH_TOKEN contains non-placeholder value!"
      echo "[health-check][ERROR] Token should be 'placeholder-token-for-credential-isolation'"
      exit 1
    fi
    echo "[health-check] ✓ ANTHROPIC_AUTH_TOKEN is placeholder value (correct)"
  fi

  # Perform health check using BASE_URL
  echo "[health-check] Testing connectivity to Anthropic API proxy at $ANTHROPIC_BASE_URL..."

  # Extract host and port from BASE_URL (format: http://IP:PORT)
  PROXY_HOST=$(echo "$ANTHROPIC_BASE_URL" | sed -E 's|^https?://([^:]+):.*|\1|')
  PROXY_PORT=$(echo "$ANTHROPIC_BASE_URL" | sed -E 's|^https?://[^:]+:([0-9]+).*|\1|')

  # Test TCP connectivity with timeout
  if timeout 5 bash -c "cat < /dev/null > /dev/tcp/$PROXY_HOST/$PROXY_PORT" 2>/dev/null; then
    echo "[health-check] ✓ Anthropic API proxy is reachable at $ANTHROPIC_BASE_URL"
  else
    echo "[health-check][ERROR] Cannot connect to Anthropic API proxy at $ANTHROPIC_BASE_URL"
    echo "[health-check][ERROR] Proxy may not be running or network is blocked"
    exit 1
  fi
fi

# Check OpenAI/Codex configuration
if [ -n "$OPENAI_BASE_URL" ]; then
  API_PROXY_CONFIGURED=true
  echo "[health-check] Checking OpenAI API proxy configuration..."

  # Verify credentials are NOT in agent environment
  if [ -n "$OPENAI_API_KEY" ] || [ -n "$CODEX_API_KEY" ] || [ -n "$OPENAI_KEY" ]; then
    echo "[health-check][ERROR] OpenAI/Codex API key found in agent environment!"
    echo "[health-check][ERROR] Credential isolation failed - keys should only be in api-proxy container"
    echo "[health-check][ERROR] OPENAI_API_KEY=${OPENAI_API_KEY:+<present>}"
    echo "[health-check][ERROR] CODEX_API_KEY=${CODEX_API_KEY:+<present>}"
    echo "[health-check][ERROR] OPENAI_KEY=${OPENAI_KEY:+<present>}"
    exit 1
  fi
  echo "[health-check] ✓ OpenAI/Codex credentials NOT in agent environment (correct)"

  # Perform health check using BASE_URL
  echo "[health-check] Testing connectivity to OpenAI API proxy at $OPENAI_BASE_URL..."

  # Extract host and port from BASE_URL (format: http://IP:PORT)
  PROXY_HOST=$(echo "$OPENAI_BASE_URL" | sed -E 's|^https?://([^:]+):.*|\1|')
  PROXY_PORT=$(echo "$OPENAI_BASE_URL" | sed -E 's|^https?://[^:]+:([0-9]+).*|\1|')

  # Test TCP connectivity with timeout
  if timeout 5 bash -c "cat < /dev/null > /dev/tcp/$PROXY_HOST/$PROXY_PORT" 2>/dev/null; then
    echo "[health-check] ✓ OpenAI API proxy is reachable at $OPENAI_BASE_URL"
  else
    echo "[health-check][ERROR] Cannot connect to OpenAI API proxy at $OPENAI_BASE_URL"
    echo "[health-check][ERROR] Proxy may not be running or network is blocked"
    exit 1
  fi
fi

# Check GitHub Copilot configuration
if [ -n "$COPILOT_API_URL" ]; then
  API_PROXY_CONFIGURED=true
  echo "[health-check] Checking GitHub Copilot API proxy configuration..."
  echo "[health-check] COPILOT_API_URL=$COPILOT_API_URL"

  # Verify credentials are NOT in agent environment
  if [ -n "$COPILOT_API_KEY" ]; then
    echo "[health-check][ERROR] COPILOT_API_KEY found in agent environment!"
    echo "[health-check][ERROR] Credential isolation failed - API key should only be in api-proxy container"
    echo "[health-check][ERROR] COPILOT_API_KEY=${COPILOT_API_KEY:+<present>}"
    exit 1
  fi
  echo "[health-check] ✓ COPILOT_API_KEY NOT in agent environment (correct)"

  # Verify COPILOT_GITHUB_TOKEN is placeholder (protected by one-shot-token)
  if [ -n "$COPILOT_GITHUB_TOKEN" ]; then
    if [ "$COPILOT_GITHUB_TOKEN" != "placeholder-token-for-credential-isolation" ]; then
      echo "[health-check][ERROR] COPILOT_GITHUB_TOKEN contains non-placeholder value!"
      echo "[health-check][ERROR] Token should be 'placeholder-token-for-credential-isolation'"
      exit 1
    fi
    echo "[health-check] ✓ COPILOT_GITHUB_TOKEN is placeholder value (correct)"
  fi

  # Verify COPILOT_TOKEN is placeholder (if present)
  if [ -n "$COPILOT_TOKEN" ]; then
    if [ "$COPILOT_TOKEN" != "placeholder-token-for-credential-isolation" ]; then
      echo "[health-check][ERROR] COPILOT_TOKEN contains non-placeholder value!"
      echo "[health-check][ERROR] Token should be 'placeholder-token-for-credential-isolation'"
      exit 1
    fi
    echo "[health-check] ✓ COPILOT_TOKEN is placeholder value (correct)"
  fi

  # Perform health check using API URL
  echo "[health-check] Testing connectivity to GitHub Copilot API proxy at $COPILOT_API_URL..."

  # Extract host and port from API URL (format: http://IP:PORT)
  PROXY_HOST=$(echo "$COPILOT_API_URL" | sed -E 's|^https?://([^:]+):.*|\1|')
  PROXY_PORT=$(echo "$COPILOT_API_URL" | sed -E 's|^https?://[^:]+:([0-9]+).*|\1|')

  # Test TCP connectivity with timeout
  if timeout 5 bash -c "cat < /dev/null > /dev/tcp/$PROXY_HOST/$PROXY_PORT" 2>/dev/null; then
    echo "[health-check] ✓ GitHub Copilot API proxy is reachable at $COPILOT_API_URL"
  else
    echo "[health-check][ERROR] Cannot connect to GitHub Copilot API proxy at $COPILOT_API_URL"
    echo "[health-check][ERROR] Proxy may not be running or network is blocked"
    exit 1
  fi
fi

# Summary
if [ "$API_PROXY_CONFIGURED" = "true" ]; then
  echo "[health-check] =========================================="
  echo "[health-check] ✓ All API proxy health checks passed"
  echo "[health-check] ✓ Credential isolation verified"
  echo "[health-check] ✓ Connectivity established"
  echo "[health-check] =========================================="
else
  echo "[health-check] No API proxy configured (ANTHROPIC_BASE_URL, OPENAI_BASE_URL, and COPILOT_API_URL not set)"
  echo "[health-check] Skipping health checks"
fi

exit 0
