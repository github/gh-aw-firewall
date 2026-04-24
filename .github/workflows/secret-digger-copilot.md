---
name: Secret Digger (Copilot)
description: Red team agent that searches for secrets in the agent container (Copilot engine)
on:
  workflow_dispatch:
permissions:
  contents: read
  actions: read
  issues: read
  pull-requests: read
engine: copilot
imports:
  - shared/secret-audit.md
  - shared/version-reporting.md
timeout-minutes: 15
---

Begin your investigation now. Be creative, be thorough, and find those secrets!