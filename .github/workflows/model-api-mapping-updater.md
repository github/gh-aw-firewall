---
emoji: 🗺️
description: Daily refresh of the model-to-API endpoint mapping from official OpenAI and Anthropic sources.
on:
  schedule: daily around 06:00 UTC
  workflow_dispatch:
permissions:
  contents: read
tools:
  github:
    mode: gh-proxy
    toolsets: [repos]
network:
  allowed:
    - defaults
    - platform.openai.com
    - api.openai.com
    - docs.anthropic.com
    - platform.claude.com
safe-outputs:
  create-pull-request:
    allowed-files:
      - docs/model-api-mapping.json
---

# Model API Mapping Updater

## Task

Update `docs/model-api-mapping.json` with the latest model-to-API endpoint mappings from official provider documentation.

## Data Sources

1. **OpenAI**: Fetch the current model list and endpoint compatibility from `https://platform.openai.com/docs/models` and `https://platform.openai.com/docs/api-reference/responses`. Determine which models support `/v1/chat/completions`, `/v1/responses`, or both.

2. **Anthropic**: Fetch the current model list from `https://docs.anthropic.com/en/docs/about-claude/models`. All Claude models use the `/v1/messages` endpoint.

## Update Rules

1. Read the current `docs/model-api-mapping.json`.
2. For each provider, verify existing model entries are still accurate and add any new models.
3. For OpenAI models:
   - GPT-5.x family and newer → `responses` only (unless docs explicitly state chat/completions support)
   - o-series reasoning models (o1, o3, o4) → check docs for dual support
   - GPT-4.x and older → typically `chat_completions` (some support both)
4. For Anthropic models:
   - All models use `messages` endpoint
   - Add any new model families (check for version bumps like opus-4-9, sonnet-4-7, etc.)
5. Update the `lastUpdated` timestamp to the current UTC time.
6. Preserve the JSON structure and schema.

## Output

- If the mapping changed, create a pull request with title "chore: update model-to-API mapping (YYYY-MM-DD)" containing only the updated `docs/model-api-mapping.json`.
- If no changes were detected, call `noop` with explanation "Model-to-API mapping is already up to date."

## Quality Checks

- Validate the JSON is well-formed before committing.
- Do not remove existing model entries unless they are confirmed deprecated and removed from provider docs.
- Keep patterns consistent with existing entries (glob-style with `*` suffix).
