---
name: Secret Digger (Copilot)
description: Red team agent that searches for secrets in the agent container (Copilot engine)
on:
  workflow_dispatch:
permissions:
  copilot-requests: write
  contents: read
  actions: read
  issues: read
  pull-requests: read
engine: copilot
imports:
  - shared/secret-audit.md
  - shared/version-reporting.md
sandbox:
  agent:
    id: awf
timeout-minutes: 15
---

Begin your investigation now. Be creative, be thorough, and find those secrets!