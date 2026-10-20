#!/bin/bash
# Install the AWF skill for Claude Code agents
#
# Usage:
#   curl -sSL https://raw.githubusercontent.com/github/gh-aw-firewall/main/.claude/skills/awf-skill/install.sh | bash
#
# Or from local clone:
#   ./install.sh [target-project-dir]

set -e

# Default to current directory if no target specified
TARGET_DIR="${1:-.}"
SKILL_DIR="$TARGET_DIR/.claude/skills/awf-skill"

# Skill URL at repository root
SKILL_URL="https://raw.githubusercontent.com/github/gh-aw-firewall/main/skill.md"

# Determine source directory (script location or GitHub)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

if [[ -f "$REPO_ROOT/skill.md" ]]; then
    # Local installation from cloned repo
    SOURCE_FILE="$REPO_ROOT/skill.md"
    echo "Installing AWF skill from local source..."
else
    # Remote installation from GitHub
    echo "Installing AWF skill from GitHub..."
fi

# Create target directory
mkdir -p "$SKILL_DIR"

if [[ -n "$SOURCE_FILE" ]]; then
    # Copy from local source
    cp "$SOURCE_FILE" "$SKILL_DIR/SKILL.md"
else
    # Download from GitHub
    curl -sSL "$SKILL_URL" -o "$SKILL_DIR/SKILL.md"
fi

echo ""
echo "AWF skill installed successfully!"
echo ""
echo "Location: $SKILL_DIR"
echo ""
echo "The skill provides:"
echo "  - Complete AWF CLI reference"
echo "  - Domain whitelisting patterns"
echo "  - Common workflow examples"
echo "  - Debugging and troubleshooting guides"
echo ""
echo "Prerequisites:"
echo "  1. Obtain and review install.sh independently, authenticate gh, then run:"
echo "     export GH_TOKEN=\"\$(gh auth token)\""
echo "     sudo --preserve-env=GH_TOKEN bash ./install.sh"
echo "  2. Verify: sudo awf --version"
echo ""
echo "Claude Code agents in this project can now use AWF effectively!"
