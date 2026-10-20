# AWF Skill for Claude Code Agents

This skill enables Claude Code agents to effectively use the AWF (Agentic Workflow Firewall) tool for running commands with network isolation and domain whitelisting.

## What This Skill Provides

- Complete AWF CLI reference and usage patterns
- Domain whitelisting syntax and best practices
- Common workflows for GitHub Copilot, MCP servers, Playwright testing
- Debugging and log analysis commands
- Troubleshooting guide for common issues

## Installation

### Option 1: Copy to Your Project (Recommended)

Copy the skill directory to your project's `.claude/skills/` folder:

```bash
# From within your project directory
mkdir -p .claude/skills
cp -r /path/to/gh-aw-firewall/.claude/skills/awf-skill .claude/skills/
```

### Option 2: Symlink (Development)

For development, you can symlink to the source:

```bash
mkdir -p .claude/skills
ln -s /path/to/gh-aw-firewall/.claude/skills/awf-skill .claude/skills/awf-skill
```

### Option 3: Download from GitHub

```bash
mkdir -p .claude/skills/awf-skill
curl -sSL https://raw.githubusercontent.com/github/gh-aw-firewall/main/skill.md \
  -o .claude/skills/awf-skill/SKILL.md
```

## Prerequisites

Before using this skill, ensure AWF is installed:

```bash
# Obtain and review install.sh through an independently authenticated channel.
gh auth status
export GH_TOKEN="$(gh auth token)"
sudo --preserve-env=GH_TOKEN bash ./install.sh
unset GH_TOKEN

# Verify installation
sudo awf --version
```

## Usage

Once installed, the skill is automatically available to Claude Code agents working in your project. The agent can reference this skill when:

- Asked to run commands with network restrictions
- Troubleshooting network-related issues in agentic workflows
- Setting up CI/CD pipelines with network isolation
- Debugging blocked domains or traffic

### Example Agent Interaction

**User**: "Run the test suite with only GitHub domains allowed"

**Agent** (using this skill):
```bash
sudo awf --allow-domains github.com,api.github.com -- npm test
```

**User**: "The API call to arxiv.org is failing"

**Agent** (using this skill):
```bash
# Check what's being blocked
awf logs --format json | jq 'select(.isAllowed == false)'

# Add the domain
sudo awf --allow-domains github.com,arxiv.org -- your-command
```

## Skill Contents

- `SKILL.md` - Main skill definition with comprehensive AWF documentation
- `README.md` - This installation and usage guide

## Integration with Other Skills

This skill works well alongside:

- **debug-firewall** - For manual Docker debugging when AWF containers need inspection
- **awf-debug-tools** - Python scripts for advanced log parsing and diagnostics

## Updating

To update the skill to the latest version:

```bash
# If copied
rm -rf .claude/skills/awf-skill
cp -r /path/to/updated/gh-aw-firewall/.claude/skills/awf-skill .claude/skills/

# If symlinked
# Just update the source repository
cd /path/to/gh-aw-firewall && git pull
```

## License

This skill is part of the gh-aw-firewall project and is licensed under MIT.
