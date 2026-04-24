---
# gh-aw Extension - Shared Component
# Installs the gh-aw CLI extension for use in pre-agent steps.
#
# Usage:
#   imports:
#     - uses: shared/mcp/gh-aw.md

steps:
  - name: Install gh-aw extension
    env:
      GH_TOKEN: ${{ secrets.GH_AW_GITHUB_MCP_SERVER_TOKEN || secrets.GH_AW_GITHUB_TOKEN || secrets.GITHUB_TOKEN }}
    run: |
      # Install gh-aw if binary not already present.
      # NOTE: Do NOT use 'gh aw --version' to detect installation — newer gh CLI versions
      # return exit code 0 with an "available as official extension" message even when the
      # extension binary is not installed, which would silently skip the install step.
      GH_AW_BIN=$(which gh-aw 2>/dev/null || find "${HOME}/.local/share/gh/extensions/gh-aw" -name 'gh-aw' -type f 2>/dev/null | head -1)
      if [ -z "$GH_AW_BIN" ] || [ ! -f "$GH_AW_BIN" ]; then
        echo "Installing gh-aw extension..."
        # Download to a temp file first so curl failures are detected (avoids silent pipe failure)
        curl -fsSL https://raw.githubusercontent.com/github/gh-aw/refs/heads/main/install-gh-aw.sh -o /tmp/install-gh-aw.sh
        bash /tmp/install-gh-aw.sh
        rm -f /tmp/install-gh-aw.sh
        GH_AW_BIN=$(which gh-aw 2>/dev/null || find "${HOME}/.local/share/gh/extensions/gh-aw" -name 'gh-aw' -type f 2>/dev/null | head -1)
      fi
      gh aw --version
      # Copy the gh-aw binary to RUNNER_TEMP for MCP server containerization
      mkdir -p "${RUNNER_TEMP}/gh-aw"
      if [ -n "$GH_AW_BIN" ] && [ -f "$GH_AW_BIN" ]; then
        cp "$GH_AW_BIN" "${RUNNER_TEMP}/gh-aw/gh-aw"
        chmod +x "${RUNNER_TEMP}/gh-aw/gh-aw"
        echo "Copied gh-aw binary to ${RUNNER_TEMP}/gh-aw/gh-aw"
      else
        echo "::error::Failed to find gh-aw binary for MCP server"
        exit 1
      fi
---
