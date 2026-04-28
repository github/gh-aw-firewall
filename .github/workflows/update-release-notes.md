---
description: Updates release notes based on the diff between the latest tag and the previous tag
on:
  release:
    types: [published]
  workflow_dispatch:
permissions:
  contents: read
  issues: read
  pull-requests: read
sandbox:
  agent:
    version: v0.25.29
  mcp:
    version: v0.3.1
tools:
  github:
    toolsets: [default]
  bash:
    - "git log:*"
    - "git diff:*"
    - "git tag:*"
    - "git show:*"
safe-outputs:
  threat-detection:
    enabled: false
  update-release:
    max: 1
timeout-minutes: 10
---

# Update Release Notes

You are an AI agent that enhances release notes by analyzing the code changes between the latest release tag and the prior tag.

## Your Task

1. **Get Release Context**:
   - The release that triggered this workflow is for tag `${{ github.event.release.tag_name }}`
   - Get the release details using GitHub tools

2. **Find the Previous Tag**:
   - Use `git tag --sort=-version:refname` to list tags sorted by version (requires semantic versioning format like v1.0.0)
   - Identify the previous tag (the tag before `${{ github.event.release.tag_name }}`)
   - If no previous tag exists, this is the first release - skip the diff analysis and note this in the summary

3. **Analyze the Diff**:
   - Use `git log <previous_tag>..${{ github.event.release.tag_name }} --oneline` to see the commits between the two tags
   - Use `git diff <previous_tag>..${{ github.event.release.tag_name }} --stat` to get a summary of file changes
   - For significant changes, review the actual diff content

4. **Generate Enhanced Release Notes**:
   Based on the diff analysis, create comprehensive release notes that include:
   
   ### Summary
   A brief overview of what changed in this release (2-3 sentences).
   
   ### What's Changed
   Categorized list of changes:
   - **Features**: New functionality added
   - **Bug Fixes**: Issues that were resolved
   - **Security**: Security-related changes
   - **Documentation**: Documentation updates
   - **Refactoring**: Code improvements without functional changes
   - **Dependencies**: Dependency updates
   
   ### Technical Details
   Key technical changes that developers should be aware of:
   - Files significantly modified
   - New files added
   - Breaking changes (if any)
   
   ### Upgrade Notes
   If there are any breaking changes or special upgrade considerations, list them here.

5. **Update the Release**:
   Use the `update-release` safe output to update the release notes. Use the `replace` operation to replace the existing release notes with your enhanced version.

## Guidelines

- Keep the release notes concise but informative
- Focus on user-facing changes and developer impact
- Highlight breaking changes prominently
- If this is the first release (no previous tag), note that in the summary
- Preserve any existing content that was manually added by maintainers if it's meaningful
- Use proper markdown formatting for readability
- Do not include raw commit hashes in the main content (they can be in a collapsible section if needed)