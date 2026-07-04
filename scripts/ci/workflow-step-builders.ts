// YAML step-fragment builder functions used by the smoke-workflow post-processing
// pipeline. Each function takes an indentation string and returns a YAML step
// block ready for splicing into a compiled lock file.

import { SESSION_STATE_DIR, SAFE_XPIA_CONTENT } from './workflow-patch-patterns';

// Builds the local-install step sequence that replaces the compiled
// "Install awf binary" step so smoke tests build and run from source.
export function buildLocalInstallSteps(indent: string): string {
  const stepIndent = indent;
  const runIndent = `${indent}  `;
  const scriptIndent = `${runIndent}  `;

  return [
    `${stepIndent}- name: Setup Node.js`,
    `${runIndent}uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0`,
    `${runIndent}with:`,
    `${scriptIndent}node-version: '24'`,
    `${scriptIndent}package-manager-cache: false`,
    `${stepIndent}- name: Install awf dependencies`,
    `${runIndent}run: npm ci`,
    `${stepIndent}- name: Build awf`,
    `${runIndent}run: npm run build`,
    `${stepIndent}- name: Install awf binary (local)`,
    `${runIndent}run: |`,
    `${scriptIndent}WORKSPACE_PATH="${'${GITHUB_WORKSPACE:-$(pwd)}'}"`,
    `${scriptIndent}NODE_BIN="$(command -v node)"`,
    `${scriptIndent}if [ ! -d "$WORKSPACE_PATH" ]; then`,
    `${scriptIndent}  echo "Workspace path not found: $WORKSPACE_PATH"`,
    `${scriptIndent}  exit 1`,
    `${scriptIndent}fi`,
    `${scriptIndent}if [ ! -x "$NODE_BIN" ]; then`,
    `${scriptIndent}  echo "Node binary not found: $NODE_BIN"`,
    `${scriptIndent}  exit 1`,
    `${scriptIndent}fi`,
    `${scriptIndent}if [ ! -d "/usr/local/bin" ]; then`,
    `${scriptIndent}  echo "/usr/local/bin is missing"`,
    `${scriptIndent}  exit 1`,
    `${scriptIndent}fi`,
    `${scriptIndent}sudo tee /usr/local/bin/awf > /dev/null <<EOF`,
    `${scriptIndent}#!/bin/bash`,
    `${scriptIndent}exec "${'${NODE_BIN}'}" "${'${WORKSPACE_PATH}'}/dist/cli.js" "\\$@"`,
    `${scriptIndent}EOF`,
    `${scriptIndent}sudo chmod +x /usr/local/bin/awf`,
  ].join('\n') + '\n';
}

// Builds the replacement step that copies session state from the AWF-managed
// host path (populated via --session-state-dir) into the agent logs directory
// so it is captured by the existing artifact upload step.
export function buildCopySessionStateStep(indent: string): string {
  const i = indent;
  const ri = `${i}    `;
  return (
    `${i}- name: Copy Copilot session state files to logs\n` +
    `${i}  if: always()\n` +
    `${i}  continue-on-error: true\n` +
    `${i}  run: |\n` +
    `${ri}SESSION_STATE_SRC="${SESSION_STATE_DIR}"\n` +
    `${ri}LOGS_DIR="/tmp/gh-aw/sandbox/agent/logs"\n` +
    `${ri}if [ -d "$SESSION_STATE_SRC" ] && [ -n "$(ls -A "$SESSION_STATE_SRC" 2>/dev/null)" ]; then\n` +
    `${ri}  mkdir -p "$LOGS_DIR/session-state"\n` +
    `${ri}  cp -rp "$SESSION_STATE_SRC/." "$LOGS_DIR/session-state/"\n` +
    `${ri}  echo "Copied session state to $LOGS_DIR/session-state"\n` +
    `${ri}else\n` +
    `${ri}  echo "No session state found at $SESSION_STATE_SRC"\n` +
    `${ri}fi\n`
  );
}

// Builds the YAML for the "Strip execute bits" step.
export function buildStripExecBitsStep(indent: string): string {
  const i = indent;
  const ri = `${i}    `;
  return (
    `${i}- name: Strip execute bits from cache-memory files\n` +
    `${i}  if: always()\n` +
    `${i}  env:\n` +
    `${i}    GH_AW_CACHE_DIR: /tmp/gh-aw/cache-memory\n` +
    `${i}  run: |\n` +
    `${ri}CACHE_DIR="\${GH_AW_CACHE_DIR:-/tmp/gh-aw/cache-memory}"\n` +
    `${ri}# Strip execute bits from all non-.git files to prevent execute-bit\n` +
    `${ri}# persistence of attacker-planted executables across cache restore cycles.\n` +
    `${ri}if [ -d "$CACHE_DIR" ]; then\n` +
    `${ri}  find "$CACHE_DIR" -not -path '*/.git/*' -type f -exec chmod a-x {} + || true\n` +
    `${ri}  echo "Execute bits stripped from cache-memory working tree"\n` +
    `${ri}else\n` +
    `${ri}  echo "Skipping execute-bit stripping; cache-memory directory not present"\n` +
    `${ri}fi\n`
  );
}

// Builds the YAML for the "Scan cache-memory for instruction-injection" step.
export function buildScanInjectionStep(indent: string): string {
  const i = indent;
  const ri = `${i}    `;
  return (
    `${i}- name: Scan cache-memory for instruction-injection content\n` +
    `${i}  if: always()\n` +
    `${i}  env:\n` +
    `${i}    GH_AW_CACHE_DIR: /tmp/gh-aw/cache-memory\n` +
    `${i}  run: |\n` +
    `${ri}CACHE_DIR="\${GH_AW_CACHE_DIR:-/tmp/gh-aw/cache-memory}"\n` +
    `${ri}# Quarantine files containing instruction-shaped content to prevent\n` +
    `${ri}# cross-run agent-context instruction injection via cache-memory.\n` +
    `${ri}# Require a colon after the keyword to reduce false positives on\n` +
    `${ri}# legitimate files (e.g. '## System Requirements', 'Override: false').\n` +
    `${ri}INJECTION_PATTERN='^(New instruction:|SYSTEM:|Ignore (all |previous |prior )instructions?:|<system>)'\n` +
    `${ri}QUARANTINE_DIR="\${GH_AW_CACHE_DIR:-/tmp/gh-aw/cache-memory}/.quarantine"\n` +
    `${ri}mapfile -t SUSPICIOUS_FILES < <(\n` +
    `${ri}  find "$CACHE_DIR" -not -path '*/.git/*' -not -path '*/.quarantine/*' -type f \\\n` +
    `${ri}    -exec grep -lEi "$INJECTION_PATTERN" {} \\; 2>/dev/null || true\n` +
    `${ri})\n` +
    `${ri}if [ \${#SUSPICIOUS_FILES[@]} -gt 0 ]; then\n` +
    `${ri}  mkdir -p "$QUARANTINE_DIR"\n` +
    `${ri}  for f in "\${SUSPICIOUS_FILES[@]}"; do\n` +
    `${ri}    rel="\${f#\${CACHE_DIR}/}"\n` +
    `${ri}    echo "::warning::Quarantining file with instruction-shaped content: $f"\n` +
    `${ri}    echo "--- First 5 lines of quarantined file: $f ---"\n` +
    `${ri}    head -5 "$f" | sed 's/^/| /' || true\n` +
    `${ri}    mkdir -p "$QUARANTINE_DIR/$(dirname "$rel")"\n` +
    `${ri}    mv -f "$f" "$QUARANTINE_DIR/$rel"\n` +
    `${ri}  done\n` +
    `${ri}  echo "Quarantined \${#SUSPICIOUS_FILES[@]} file(s) with instruction-shaped content to $QUARANTINE_DIR"\n` +
    `${ri}else\n` +
    `${ri}  echo "No instruction-injection content found in cache-memory"\n` +
    `${ri}fi\n`
  );
}

// Builds the YAML for the "Compute cache-memory TTL date key" step.
export function buildCacheDateStep(indent: string): string {
  return (
    `${indent}- name: Compute cache-memory TTL date key\n` +
    `${indent}  run: echo "CACHE_MEMORY_DATE=$(date -u +%Y%m%d)" >> "$GITHUB_ENV"\n`
  );
}

// Builds the safe inline xpia.md heredoc replacement.
// Preserve empty lines as truly empty (no trailing whitespace) to keep the
// YAML block scalar clean and diff-friendly.
export function buildXpiaHeredoc(indent: string, appendSuffix: string): string {
  const heredocLines = SAFE_XPIA_CONTENT.split('\n')
    .map((line) => (line.trim() ? `${indent}${line}` : ''))
    .join('\n');
  return (
    `${indent}cat << 'GH_AW_XPIA_SAFE_EOF'${appendSuffix}\n` +
    `${heredocLines}\n` +
    `${indent}GH_AW_XPIA_SAFE_EOF\n`
  );
}
