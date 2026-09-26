---
emoji: 🗺️
description: Daily refresh of the model-to-API endpoint mapping from official OpenAI and Anthropic sources.
on:
  schedule: daily around 06:00 UTC
  workflow_dispatch:
permissions:
  copilot-requests: write
  contents: read
sandbox:
  agent:
    id: awf
tools:
  github:
    toolsets: [repos]
  bash: ["cat", "curl", "date", "grep", "head", "jq", "ls", "git diff", "git status"]
  edit:
network:
  allowed:
    - defaults
    - platform.openai.com
    - developers.openai.com
    - api.openai.com
    - docs.anthropic.com
    - platform.claude.com
steps:
  - name: Pre-fetch provider model documentation
    run: |
      # Fetch provider docs on the host runner so the agent reads trimmed text
      # instead of spending turns downloading raw HTML.
      DOCS_DIR=/tmp/gh-aw/model-docs
      mkdir -p "$DOCS_DIR"
      fetch() {
        local out="$1"; shift
        for url in "$@"; do
          if curl -sSL --fail --max-time 60 "$url" -o "$DOCS_DIR/$out.html"; then
            echo "$url" > "$DOCS_DIR/$out.source"
            echo "Fetched $out from $url"
            return 0
          fi
          echo "::warning::Failed to fetch $url"
        done
        rm -f "$DOCS_DIR/$out.html"
        return 0
      }
      fetch openai-models \
        https://developers.openai.com/api/docs/models \
        https://platform.openai.com/docs/models
      fetch openai-responses \
        https://developers.openai.com/api/reference/responses/overview
      fetch anthropic-models \
        https://docs.anthropic.com/en/docs/about-claude/models \
        https://platform.claude.com/docs/en/about-claude/models/overview
      # Strip scripts, styles, and markup to shrink the agent's context.
      python3 - "$DOCS_DIR" <<'PY'
      import html, pathlib, re, sys
      docs = pathlib.Path(sys.argv[1])
      for page in sorted(docs.glob("*.html")):
          text = page.read_text(encoding="utf-8", errors="replace")
          text = re.sub(r"(?is)<(script|style|noscript|svg)[^>]*>.*?</\1>", " ", text)
          text = re.sub(r"(?s)<[^>]+>", " ", text)
          text = html.unescape(text)
          lines = [re.sub(r"\s+", " ", line).strip() for line in text.splitlines()]
          text = "\n".join(line for line in lines if line)
          page.with_suffix(".txt").write_text(text + "\n", encoding="utf-8")
          page.unlink()
          print(f"{page.stem}: {len(text)} chars")
      PY
      ls -la "$DOCS_DIR"
post-steps:
  - name: Validate model-api-mapping.json
    run: jq empty docs/model-api-mapping.json
safe-outputs:
  create-pull-request:
    allowed-files:
      - docs/model-api-mapping.json
---

# Model API Mapping Updater

## Task

Update `docs/model-api-mapping.json` with the latest model-to-API endpoint mappings from official provider documentation.

## Data Sources

Provider documentation has already been fetched and converted to plain text in `/tmp/gh-aw/model-docs/` before you started. Each `<name>.source` file records the URL the text came from. Read these files first (use `grep` to find model names) instead of fetching pages yourself.

1. **OpenAI**: `/tmp/gh-aw/model-docs/openai-models.txt` (model list) and `/tmp/gh-aw/model-docs/openai-responses.txt` (Responses API overview). Determine which models support `/v1/chat/completions`, `/v1/responses`, or both.

2. **Anthropic**: `/tmp/gh-aw/model-docs/anthropic-models.txt` (model list). All Claude models use the `/v1/messages` endpoint.

Only if a pre-fetched file is missing or clearly lacks the model list, fall back to `curl` against the original URL (`https://developers.openai.com/api/docs/models`, `https://developers.openai.com/api/reference/responses/overview`, `https://platform.openai.com/docs/models`, or `https://docs.anthropic.com/en/docs/about-claude/models`).

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

- Keep the JSON well-formed; a post-agent step runs `jq empty docs/model-api-mapping.json` and fails the run on invalid JSON.
- Do not remove existing model entries unless they are confirmed deprecated and removed from provider docs.
- Keep patterns consistent with existing entries (glob-style with `*` suffix).
