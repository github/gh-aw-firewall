import * as fs from 'fs';
import type { BoundedQueryRepository } from '../types/bounded-query-options';
import { BOUNDED_QUERY_SENSITIVITY_RUN_BITS } from '../types/bounded-query-options';
import {
  AGENT_SKILL_PATH,
  QUERY_MOUNT_DIR,
  type BoundedQueryPaths,
} from './paths';
import { CANONICAL_ERROR_JSON, MAX_SCRIPT_BYTES, RESULT_STATUS_BIT_COST, TIMING_BUCKETS_MS, TIMING_BUCKET_BITS } from './protocol';

/**
 * Generates the bounded-query skill document handed to the primary agent.
 *
 * The document is *guidance*, not a security boundary: every rule it states is
 * independently enforced by the `bounded-query` wrapper and by the trusted
 * broker. Its job is to tell the agent which repositories exist (and at what
 * confidentiality budget), the v2 request contract (agent-authored finite
 * schema plus script), and the observable canonical result envelope.
 */

interface BoundedQuerySkillParams {
  /** Configured repositories, in configuration order. */
  repos: BoundedQueryRepository[];
  /** Per-invocation wall-clock limit, in seconds. */
  timeoutSeconds: number;
  /** Per-run invocation budget (an independent operational cap; see "Budget" below). */
  maxInvocations: number;
}

function formatRunBudget(repo: BoundedQueryRepository): string {
  const bits = BOUNDED_QUERY_SENSITIVITY_RUN_BITS[repo.sensitivity];
  if (bits === null) return `unmetered (\`${repo.sensitivity}\`)`;
  if (bits === 0) return `0 bits/run (\`${repo.sensitivity}\` — never runs a script)`;
  return `${bits} bits/run (\`${repo.sensitivity}\`)`;
}

export function generateBoundedQuerySkill(params: BoundedQuerySkillParams): string {
  const { repos, timeoutSeconds, maxInvocations } = params;
  const repoList = repos.map((repo) => `- \`${repo.repo}\` — ${formatRunBudget(repo)}`).join('\n');
  const bucketList = TIMING_BUCKETS_MS.map((ms) => (ms >= 1000 ? `${ms / 1000}s` : `${ms}ms`)).join(', ');

  return `---
name: bounded-query
description: >-
  Run a short Python 3 script against one pre-approved private repository
  inside an isolated, offline sandbox and get back a value conforming to a
  finite response schema you declare up front. Use when you must answer a
  bounded question about private repository contents that you are not
  allowed to read, and only when your remaining per-repository information
  budget can afford the answer's schema.
---

# Bounded query

A bounded query runs an agent-authored Python 3 script against a fresh, writable
copy of exactly one pre-approved private repository.
The sandbox has no network, no credentials, no host access,
and no access to this workspace.

You never see the repository contents, the script's stdout/stderr, its files,
its diffs, its exit status, or any diagnostics. The only thing you observe is
one canonical JSON result:

- \`{"status":"ok","result":<value>}\` where \`<value>\` conforms to the exact
  response schema you declared, or
- \`${CANONICAL_ERROR_JSON}\` for **every** failure mode (invalid request,
  disallowed repository, exhausted budget, launch failure, timeout, crash,
  non-conformant output, internal error). Failures are indistinguishable from
  each other by design — do not try to infer which one occurred.

## Available repositories

${repoList}

Any other repository is rejected. The sensitivity and run budget shown above
are fixed by AWF configuration; a request cannot choose or override them.

## Invoking

\`\`\`bash
bounded-query \\
  --repo owner/repo \\
  --schema '{"type":"boolean"}' \\
  < query.py
\`\`\`

Rules enforced by the CLI:

- exactly one \`--repo\`, and it must be one of the repositories listed above;
- exactly one \`--schema\`: a JSON document (see "Response schema" below);
- the script is read from stdin and must be at most ${MAX_SCRIPT_BYTES} bytes;
- there are no other options. You cannot choose the image, command,
  interpreter, runtime, timeout, mount, path, ref, URL, environment, or
  credentials.

The CLI always prints exactly one line of JSON and always exits \`0\`.

## Response schema

The schema is a deliberately finite, agent-authored algebra — **not** general
JSON Schema. Every invocation may use a different schema. Supported node
types:

| type | shape | notes |
| --- | --- | --- |
| \`const\` | \`{"type":"const","value":<literal>}\` | one fixed value |
| \`boolean\` | \`{"type":"boolean"}\` | \`true\` or \`false\` |
| \`enum\` | \`{"type":"enum","values":[<literal>,...]}\` | unique literals, same JSON type |
| \`integer\` | \`{"type":"integer","minimum":N,"maximum":M}\` | inclusive bounded range |
| \`object\` | \`{"type":"object","fields":{"name":<schema>,...}}\` | every field required, no extras |
| \`tuple\` | \`{"type":"tuple","items":[<schema>,...]}\` | fixed-length, per-position schema |
| \`array\` | \`{"type":"array","items":<schema>,"length":N}\` | fixed length, uniform item schema |
| \`union\` | \`{"type":"union","variants":{"tag":<schema>,...}}\` | value is \`{"tag":"...","value":...}\` |

A literal (in \`const\`/\`enum\`) is a JSON string (at most 64 bytes, no control
characters), a safe integer, a boolean, or \`null\`. There is no way to express
an unbounded string, a float, a regex, recursion, \`$ref\`, an optional field,
\`additionalProperties\`, or an untagged/overlapping union — these are
structurally impossible, not merely disallowed.

Example — a bounded integer count:

\`\`\`json
{"type": "integer", "minimum": 0, "maximum": 100}
\`\`\`

## Script contract

The script runs as \`python3\` with the **standard library only** (no third-party
packages, no package installation, no network). It may read and freely modify
\`${QUERY_MOUNT_DIR}/repo\`; every mutation is discarded when the query ends.

It must write its answer to \`${QUERY_MOUNT_DIR}/out\` as a single JSON value
conforming exactly to your declared schema:

\`\`\`python
import json
from pathlib import Path

repo = Path("${QUERY_MOUNT_DIR}/repo")
found = any(repo.rglob("Dockerfile"))
Path("${QUERY_MOUNT_DIR}/out").write_text(json.dumps(found))
\`\`\`

Anything else in the output — wrong type, out-of-range value, unknown enum
member, extra/missing fields, wrong tuple/array length, malformed or
duplicate-key JSON, an oversized file, no file at all — is reported to you as
\`${CANONICAL_ERROR_JSON}\`.

## Budget

Every invocation reserves a fixed information charge from its repository's
run budget, computed **before** anything runs:

\`\`\`text
charge = ${RESULT_STATUS_BIT_COST} (ok/error) + ceil(log2(schema cardinality)) + ${TIMING_BUCKET_BITS} (timing)
\`\`\`

"Schema cardinality" is the number of distinguishable values your declared
schema admits (2 for \`boolean\`, N for an N-member \`enum\`, the product of
field cardinalities for \`object\`/\`tuple\`, and so on). The charge is debited
from the repository's remaining run balance whether the script succeeds,
fails, or times out, and is never refunded. An invocation is only allowed if
its charge fits the remaining balance — there is no separate per-query cap,
so a cheap boolean question and an expensive high-cardinality question both
draw from the same shared budget, just at different rates.

Timing is charged because it is observable: the broker always returns at the
first bucket boundary at or after your script actually finishes (bucket
boundaries: ${bucketList}), so a fast script and a slow script are
distinguishable through response latency alone, and that must be paid for
like any other signal.

- Each invocation may run for at most ${timeoutSeconds} second(s).
- At most ${maxInvocations} invocation(s) are permitted for this entire run,
  independent of the bit budget above. Further calls return
  \`${CANONICAL_ERROR_JSON}\` without running anything.
- A repository whose remaining budget cannot afford even the cheapest
  possible schema (a \`const\` schema, minimum charge
  ${RESULT_STATUS_BIT_COST + TIMING_BUCKET_BITS} bits) can no longer be queryd
  at all for the rest of this run.

Design one high-value, low-cardinality question per invocation.
`;
}

/**
 * Writes the generated skill into the agent-visible artifact directory.
 *
 * The file is securely created 0600 under an AWF-owned directory inside
 * `workDir`, then made 0644 for the agent's read-only bind mount. Nothing is
 * written to the host user's home directory or to the workspace.
 */
export function writeBoundedQuerySkill(paths: BoundedQueryPaths, params: BoundedQuerySkillParams): string {
  fs.mkdirSync(paths.agentDir, { recursive: true, mode: 0o755 });
  const content = generateBoundedQuerySkill(params);
  // O_EXCL | O_NOFOLLOW: atomically create; fail if a symlink or existing file
  // is already at this path (insecure-temp-file guard).
  const fd = fs.openSync(
    paths.skillPath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeSync(fd, content);
    // The protected 0755 parent exposes only this non-sensitive generated
    // guidance file; world-readability is required across the agent UID mount.
    fs.fchmodSync(fd, 0o644);
  } finally {
    fs.closeSync(fd);
  }
  return AGENT_SKILL_PATH;
}
