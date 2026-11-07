---
mcp-scripts:
  gh:
    description: "Execute an approved read-only gh CLI command. This tool is accessible as 'safeinputs-gh'. Provide a read-only command after 'gh' (e.g., args: 'pr list --limit 5')."
    inputs:
      args:
        type: string
        description: "Arguments for an approved read-only gh command (without the 'gh' prefix). Examples: 'pr list --limit 5', 'issue view 123', 'api repos/{owner}/{repo}'"
        required: true
    env:
      GH_AW_GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    run: |
      python3 "${GITHUB_WORKSPACE}/scripts/ci/gh-readonly.py" "$INPUT_ARGS"
---

**IMPORTANT**: Always use the `safeinputs-gh` tool for GitHub CLI commands instead of running `gh` directly via bash. The `safeinputs-gh` tool has proper authentication configured with `GITHUB_TOKEN`, while bash commands do not have GitHub CLI authentication by default.

**Correct**:
```
Use the safeinputs-gh tool with args: "pr list --limit 5"
Use the safeinputs-gh tool with args: "issue view 123"
```

**Incorrect**:
```
Use the gh safe-input tool with args: "pr list --limit 5"  ❌ (Wrong tool name - use safeinputs-gh)
Run: gh pr list --limit 5  ❌ (No authentication in bash)
Execute bash: gh issue view 123  ❌ (No authentication in bash)
```
