import * as fs from 'fs';
import {
  AGENT_SKILL_PATH,
  PROBE_MOUNT_DIR,
  type SealedProbePaths,
} from './paths';
import { OUTCOME_COUNT, RESERVED_ERROR_OUTCOME } from './protocol';

/**
 * Generates the sealed-probe skill document handed to the primary agent.
 *
 * The document is *guidance*, not a security boundary: every rule it states is
 * independently enforced by the `sealed-probe` wrapper and by the trusted
 * broker. Its job is to tell the agent which repositories exist, what the CLI
 * contract is, and what the (deliberately tiny) observable output is.
 */

interface SealedProbeSkillParams {
  /** Configured repository slugs, in configuration order. */
  repos: string[];
  /** Per-invocation wall-clock limit, in seconds. */
  timeoutSeconds: number;
  /** Per-run invocation budget. */
  maxInvocations: number;
}

export function generateSealedProbeSkill(params: SealedProbeSkillParams): string {
  const { repos, timeoutSeconds, maxInvocations } = params;
  const repoList = repos.map((repo) => `- \`${repo}\``).join('\n');

  return `---
name: sealed-probe
description: >-
  Run a short Python 3 script against one pre-approved private repository
  inside a sealed, offline sandbox and learn only which of exactly
  ${OUTCOME_COUNT} declared outcomes occurred. Use when you must answer a
  bounded question about private repository contents that you are not allowed
  to read.
---

# Sealed probe

A sealed probe runs an agent-authored Python 3 script against a fresh, writable
copy of exactly one pre-approved private repository.
The sandbox has no network, no credentials, no host access,
and no access to this workspace.

You never see the repository contents, the script's stdout/stderr, its files,
its diffs, its exit status, or any diagnostics. **The only thing you observe is
one of ${OUTCOME_COUNT + 1} symbols**: one of the ${OUTCOME_COUNT} outcomes you
declared, or the fixed value \`${RESERVED_ERROR_OUTCOME}\`.

## Available repositories

${repoList}

Any other repository is rejected.

## Invoking

\`\`\`bash
sealed-probe \\
  --repo owner/repo \\
  --outcome YES \\
  --outcome NO \\
  --outcome UNKNOWN \\
  < probe.py
\`\`\`

Rules enforced by the CLI:

- exactly one \`--repo\`, and it must be one of the repositories listed above;
- exactly ${OUTCOME_COUNT} \`--outcome\` values: unique ASCII identifiers that
  start with a letter, contain only letters, digits, \`_\`, or \`-\`, are at
  most 64 bytes, and do not equal \`${RESERVED_ERROR_OUTCOME}\`;
- the script is read from stdin;
- there are no other options. You cannot choose the image, command, interpreter,
  runtime, timeout, mount, path, ref, URL, environment, or credentials.

The CLI always prints exactly one line of JSON and always exits \`0\`.

## Script contract

The script runs as \`python3\` with the **standard library only** (no third-party
packages, no package installation, no network). It may read and freely modify
\`${PROBE_MOUNT_DIR}/repo\`; every mutation is discarded when the probe ends.

It must write its answer to \`${PROBE_MOUNT_DIR}/out\` as a single JSON object:

\`\`\`python
import json
from pathlib import Path

repo = Path("${PROBE_MOUNT_DIR}/repo")
found = any(repo.rglob("Dockerfile"))
Path("${PROBE_MOUNT_DIR}/out").write_text(json.dumps({"result": "YES" if found else "NO"}))
\`\`\`

Anything else in the output — extra keys, trailing data, a value outside your
declared outcomes, malformed JSON, an oversized file, no file at all — is
reported to you as \`${RESERVED_ERROR_OUTCOME}\`.

## Result

\`\`\`json
{"result":"YES"}
\`\`\`

\`{"result":"${RESERVED_ERROR_OUTCOME}"}\` is returned for **every** failure:
invalid request, disallowed repository, exhausted invocation budget, launch
failure, timeout, crash, out-of-memory, non-conformant output, or internal
error. The failures are indistinguishable from each other by design — do not
try to infer which one occurred.

## Budget

- Each invocation may run for at most ${timeoutSeconds} second(s).
- At most ${maxInvocations} invocation(s) are permitted for this entire run.
  Further calls return \`${RESERVED_ERROR_OUTCOME}\` without running anything.

Because each answer is one of ${OUTCOME_COUNT + 1} symbols, a probe conveys
at most 2 bits about the repository. Design one high-value question per
invocation.
`;
}

/**
 * Writes the generated skill into the agent-visible artifact directory.
 *
 * The file is created 0644 under an AWF-owned directory inside `workDir`; it is
 * mounted read-only into the agent. Nothing is written to the host user's home
 * directory or to the workspace.
 */
export function writeSealedProbeSkill(paths: SealedProbePaths, params: SealedProbeSkillParams): string {
  fs.mkdirSync(paths.agentDir, { recursive: true, mode: 0o755 });
  fs.writeFileSync(paths.skillPath, generateSealedProbeSkill(params), { mode: 0o644 });
  fs.chmodSync(paths.skillPath, 0o644);
  return AGENT_SKILL_PATH;
}
