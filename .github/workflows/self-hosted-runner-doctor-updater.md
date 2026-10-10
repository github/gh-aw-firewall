---
name: Runner Doctor Updater
description: Daily workflow that reviews new self-hosted, ARC/DinD, GHEC, and GHES issues and PRs since the previous run and proposes updates to keep the Self-Hosted Runner Doctor knowledge base current.
on:
  schedule: daily
  workflow_dispatch:
  skip-if-match:
    query: 'is:issue is:open label:runner-doctor'
    max: 1
if: needs.prepare_candidates.outputs.has_candidates == 'true'
jobs:
  prepare_candidates:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      issues: read
      pull-requests: read
    outputs:
      has_candidates: ${{ steps.prepare.outputs.has_candidates }}
    steps:
      - name: Checkout repository
        uses: actions/checkout@v7.0.1
      - name: Prepare runner doctor context
        id: prepare
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          set -euo pipefail
          CONTEXT_DIR=/tmp/gh-aw/agent
          mkdir -p "$CONTEXT_DIR"

          # Look back two days so a missed daily run does not create a coverage gap.
          SINCE=$(date -u -d '2 days ago' +%Y-%m-%d)
          echo "$SINCE" > "$CONTEXT_DIR/scan-since.txt"

          {
            for finding in docs/diagnostics/findings/runner/*.json; do
              jq -r '.references[]? | select(.kind == "issue" or .kind == "pull-request") | .ref |
                select(test("^https://github.com/github/gh-aw-firewall/(issues|pull)/[0-9]+$")) |
                sub("^https://github.com/github/gh-aw-firewall/(issues|pull)/"; "github/gh-aw-firewall#")' \
                "$finding"
            done
            grep -hEo 'github/gh-aw-firewall#[0-9]+' .github/workflows/shared/self-hosted-failure-modes.md || true
            grep -hEo '(^|[ ,])#[0-9]+' .github/workflows/shared/self-hosted-failure-modes.md |
              sed -E 's/^[ ,]*//' || true
          } | sort -u > "$CONTEXT_DIR/covered.txt"

          {
            find docs/diagnostics/findings/runner -maxdepth 1 -type f -name '*.json' -printf '%f\n' |
              sed -E 's/\.json$//'
            grep -Eo '^\| [A-D][0-9]+' .github/workflows/shared/self-hosted-failure-modes.md |
              sed -E 's/^\| //'
          } | sort -u > "$CONTEXT_DIR/failure-mode-ids.txt"

          : > "$CONTEXT_DIR/next-ids.txt"
          for category in A B C D; do
            max_id=$(awk -v category="$category" '
              substr($0, 1, 1) == category {
                id = substr($0, 2)
                if (id + 0 > max) max = id + 0
              }
              END { print max + 0 }
            ' "$CONTEXT_DIR/failure-mode-ids.txt")
            echo "$category$((max_id + 1))" >> "$CONTEXT_DIR/next-ids.txt"
          done

          CANDIDATE_RESULTS=/tmp/gh-aw/candidate-results.jsonl
          : > "$CANDIDATE_RESULTS"
          queries=(
            '"ARC" OR "DinD" OR "self-hosted" OR "GHES" OR "GHEC" OR "ghe.com"'
            '"DOCKER_HOST" OR "docker-host-path-prefix" OR "chroot" OR "musl" OR "Alpine" OR "IPv6" OR "corporate proxy"'
            '"cache_peer" OR "GH_HOST" OR "resolv.conf" OR "toolcache" OR "_tool" OR "one-shot-token" OR "capsh" OR "passwd"'
          )
          for signals in "${queries[@]}"; do
            gh api --method GET --paginate search/issues \
              -f q="repo:${GITHUB_REPOSITORY} updated:>=$SINCE ($signals)" \
              -f per_page=100 \
              --jq '.items[] | {number, title, url, state, updated_at, is_pull_request: has("pull_request")}' \
              >> "$CANDIDATE_RESULTS"
          done
          jq -s 'unique_by(.number) | sort_by(.number)' "$CANDIDATE_RESULTS" \
            > "$CONTEXT_DIR/candidates.json"
          rm "$CANDIDATE_RESULTS"
          candidate_count=$(jq 'length' "$CONTEXT_DIR/candidates.json")
          echo "Prepared $candidate_count runner-doctor candidates since $SINCE"
          echo "candidate_count=$candidate_count" >> "$GITHUB_OUTPUT"
          if [ "$candidate_count" -gt 0 ]; then
            echo "has_candidates=true" >> "$GITHUB_OUTPUT"
          else
            echo "has_candidates=false" >> "$GITHUB_OUTPUT"
          fi
      - name: Upload runner doctor context
        if: steps.prepare.outputs.has_candidates == 'true'
        uses: actions/upload-artifact@v7.0.2
        with:
          name: runner-doctor-context
          path: /tmp/gh-aw/agent/
          if-no-files-found: error
          retention-days: 1
permissions:
  copilot-requests: write
  contents: read
  issues: read
  pull-requests: read
imports:
  - shared/diagnosis-maintenance.md
tools:
  github:
    toolsets: [issues, pull_requests]
  bash: true
sandbox:
  agent:
    id: awf
network:
  allowed:
    - github
safe-outputs:
  threat-detection:
    enabled: false
  create-issue:
    title-prefix: "🩺 Runner Doctor Update"
    labels: [runner-doctor, automated]
    max: 1
    expires: 30d
timeout-minutes: 20
steps:
  - name: Download prepared runner doctor context
    uses: actions/download-artifact@v8.0.2
    with:
      name: runner-doctor-context
      path: /tmp/gh-aw/agent
  - name: Install root dependencies for diagnostics tooling
    run: |
      for attempt in 1 2 3; do
        if npm ci; then
          break
        fi
        if [ "$attempt" -eq 3 ]; then
          exit 1
        fi
        sleep $((attempt * 5))
      done
---

# Runner Doctor Updater

You are the maintenance agent for the **Self-Hosted Runner Doctor**. Each day you review newly updated issues and pull requests that relate to AWF on non-GitHub-hosted environments — self-hosted runners, ARC + DinD, GHEC (`*.ghe.com`), GHES, and enterprise runners — and you propose concrete updates so the doctor's knowledge base stays current.

You do **not** edit files yourself. Your only output is a single proposed-changes issue (or a `noop`).

## Scan window

- **Repository:** ${{ github.repository }}
- **Since (UTC date):** (read from `/tmp/gh-aw/agent/scan-since.txt` via `cat /tmp/gh-aw/agent/scan-since.txt`)

Consider issues and pull requests **updated on or after** the scan window. The window deliberately overlaps the previous daily run, so de-duplicate against lessons that are already captured.

## Step 1 — Find relevant issues and PRs

Read the compact candidate list at `/tmp/gh-aw/agent/candidates.json`. It contains issue/PR numbers, titles, URLs, states, update dates, and a pull-request flag, gathered from the signals below and `updated:>=<SINCE_DATE>`. Fetch full details and key comments only for candidates not already covered. Do not repeat the broad candidate searches.

`ARC`, `DinD`, `self-hosted`, `GHES`, `GHEC`, `ghe.com`, `DOCKER_HOST`, `docker-host-path-prefix`, `chroot`, `musl`, `Alpine`, `IPv6`, `corporate proxy`, `cache_peer`, `GH_HOST`, `resolv.conf`, `toolcache`, `_tool`, `one-shot-token`, `capsh`, `passwd`.

Include **both open and closed** items — closed issues and merged PRs usually carry the actual fix and the citation numbers worth recording. Read the body and key comments of each candidate to confirm it is a genuine non-hosted-runner lesson (ignore unrelated CI flakes, refactors, and GitHub-hosted-only reports).

## Step 2 — Extract the lesson

For each relevant item, capture: the observable symptom / error string, the affected platform(s), the root cause, the fix (AWF flag, config field, env var, or version bump), and a read-only diagnostic the doctor could run.

## Step 3 — Compare against the current doctor

Use `/tmp/gh-aw/agent/covered.txt` to identify citations already covered and `/tmp/gh-aw/agent/next-ids.txt` for the next free failure-mode ID per category. The catalog is intentionally not inlined. Use targeted searches and read only matching sections:

```bash
grep -n "#<ISSUE_OR_PR_NUMBER>" .github/workflows/shared/self-hosted-failure-modes.md
grep -n -A30 -B5 "<matching symptom or failure-mode ID>" .github/workflows/self-hosted-runner-doctor.md
grep -n -A30 -B5 "<matching symptom or failure-mode ID>" .github/agents/self-hosted-runner-doctor.md
```

`.github/agents/self-hosted-runner-doctor.md` is the **portable, self-contained doctor agent** that users load directly into their own coding agent (without cloning the repo). It embeds a copy of the failure-mode catalog and the diagnostic playbook. Whenever you propose a change to `shared/self-hosted-failure-modes.md` (catalog rows, error-string lookup, or known-unresolved items) or to the playbook in `self-hosted-runner-doctor.md`, you **must** propose the matching edit to the embedded copy in the portable agent so the two stay in sync.

Classify each lesson as one of:

- **Already covered** — its citation issue/PR numbers already appear in the catalog ⇒ skip.
- **New failure mode** — assign the next free ID in the correct category (`A` = ARC/DinD, `B` = self-hosted, `C` = GHES/GHEC/data-residency, `D` = runtimes/network) and propose a new table row.
- **Update to an existing mode** — add a new citation, flip a status (e.g. open → fixed), or improve the fix/probe wording.
- **New error-string lookup entry** — a recognizable error string that should map to a mode in the doctor's quick-lookup.

## Step 3b — Propose the canonical registry change

`docs/diagnostics/` is the canonical diagnosis state. Follow the shared
diagnosis-maintenance contract imported below: search the registry first, then
express every lesson as a canonical record change (new record, or an update to
an existing record) using the runner ID namespace `A*`/`B*`/`C*`/`D*`.

```bash
npx tsx scripts/diagnostics/cli.ts search "<redacted symptom>" --boundary runner
```

Read `docs/diagnostics/schema.json` only when a proposed record change requires checking its fields.

The runner catalog, workflow playbook and portable agent remain in place; your
proposal must name the canonical record first, then any matching catalog or
playbook edit.

## Step 4 — Avoid duplicate proposals

Before creating an issue, search existing open issues labelled `runner-doctor`. If an open proposal already covers the same lessons, call `noop` instead of stacking another issue.

## Output

If you found concrete, not-yet-captured updates, call `create-issue` **once** with this structure:

### Summary
- scan window and number of items reviewed
- number of genuinely new lessons

### Proposed canonical registry changes
For `docs/diagnostics/findings/runner/<ID>.json`: the exact record fields to add or change (id, boundary, symptoms, conditions, affects, versions, status, rootCause, probe, action, references, owner, reviewBy), valid against `docs/diagnostics/schema.json`. Note that a reviewer must run `npm run diagnostics:render` so the generated consumers stay in sync.

### Proposed knowledge-base changes
For `.github/workflows/shared/self-hosted-failure-modes.md`: the exact table row(s) to add or modify, including the failure-mode ID, category, and citation numbers.

### Proposed doctor changes
For `.github/workflows/self-hosted-runner-doctor.md`: any playbook or error-string lookup additions.

### Proposed portable agent changes
For `.github/agents/self-hosted-runner-doctor.md`: the matching edits to its embedded catalog and playbook so the portable agent stays in sync with the two files above. Every catalog or playbook change proposed for the workflow/shared files must have a corresponding edit here.

### Source issues and PRs
Every proposed change must cite the issue/PR number(s) it derives from, with links.

If there are **no** new lessons, call `noop` with a one-line explanation. Do not open an empty or speculative issue.

## Guardrails

- Propose knowledge/documentation edits only — never modify code, never open a pull request.
- Keep existing failure-mode IDs stable; only append new IDs. Supersede in place; never recycle an ID.
- Never propose a probe that dumps the environment, exchanges a token, or bypasses isolation.
- Prefer the narrowest change; do not restructure entries that already work.
- Skip anything whose citation numbers are already present in the catalog.
