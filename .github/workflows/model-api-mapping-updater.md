---
emoji: 🗺️
description: Manual read-only review of the model-to-API endpoint mapping against official OpenAI and Anthropic sources.
on:
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
  bash: ["cat", "curl", "grep", "head", "jq", "ls"]
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
    run: |
      if ! jq empty docs/model-api-mapping.json; then
        exit 1
      fi
safe-outputs:
  report-failed-jobs: false
  report-failure-as-issue: false
  report-incomplete:
    create-issue: false
  missing-tool:
    create-issue: false
  jobs:
    report-mapping-review:
      description: "Record model API mapping discrepancies in the Actions run summary."
      runs-on: ubuntu-slim
      output: "Review recorded."
      inputs:
        findings:
          description: "Evidence-backed discrepancies and official source URLs."
          required: true
          type: string
      steps:
        - name: Record review
          run: jq -er '.items[] | select(.type == "report_mapping_review") | .findings' "$GH_AW_AGENT_OUTPUT" >> "$GITHUB_STEP_SUMMARY"
  noop:
    report-as-issue: false
---

# Model API Mapping Review

## Task

Review `docs/model-api-mapping.json` against the latest model-to-API endpoint mappings from official provider documentation. Do not edit the mapping or any other repository file.

## Data Sources

Provider documentation has already been fetched and converted to plain text in `/tmp/gh-aw/model-docs/` before you started. Each `<name>.source` file records the URL the text came from. Read these files first (use `grep` to find model names) instead of fetching pages yourself.

1. **OpenAI**: `/tmp/gh-aw/model-docs/openai-models.txt` (model list) and `/tmp/gh-aw/model-docs/openai-responses.txt` (Responses API overview). Determine which models support `/v1/chat/completions`, `/v1/responses`, or both.

2. **Anthropic**: `/tmp/gh-aw/model-docs/anthropic-models.txt` (model list). All Claude models use the `/v1/messages` endpoint.

Only if a pre-fetched file is missing or clearly lacks the model list, fall back to `curl` against the original URL (`https://developers.openai.com/api/docs/models`, `https://developers.openai.com/api/reference/responses/overview`, `https://platform.openai.com/docs/models`, `https://docs.anthropic.com/en/docs/about-claude/models`, or `https://platform.claude.com/docs/en/about-claude/models/overview`).

## Review Rules

1. Read the current `docs/model-api-mapping.json`.
2. For each provider, verify existing model entries are still accurate and identify any new models.
3. For OpenAI models:
   - GPT-5.x family and newer → `responses` only (unless docs explicitly state chat/completions support)
   - o-series reasoning models (o1, o3, o4) → check docs for dual support
   - GPT-4.x and older → typically `chat_completions` (some support both)
4. For Anthropic models:
   - All models use `messages` endpoint
   - Note any new model families (check for version bumps like opus-4-9, sonnet-4-7, etc.)
5. Do not update `lastUpdated` based on the wall clock.

## Output

- Report any evidenced discrepancies and source URLs through `report-mapping-review` in the run summary only; do not create a pull request or make repository changes.
- If no discrepancies were detected, call `noop` with explanation "Model-to-API mapping is already up to date."

## Quality Checks

- A post-agent step checks that the existing JSON is well-formed.
- Do not recommend removing existing model entries unless they are confirmed deprecated and removed from provider docs.
- When reporting discrepancies, refer to existing patterns (glob-style with `*` suffix).
