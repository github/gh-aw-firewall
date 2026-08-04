import * as fs from 'fs';
import type { BoundedAgentRepository, BoundedAgentsConfig } from '../types/bounded-agent-options';
import { BOUNDED_AGENT_SENSITIVITY_RUN_BITS } from '../types/bounded-agent-options';
import { AGENT_SKILL_PATH, type BoundedAgentPaths } from './paths';
import {
  CANONICAL_ERROR_JSON,
  RESULT_STATUS_BIT_COST,
  TIMING_BUCKETS_MS,
  TIMING_BUCKET_BITS,
} from './protocol';

/**
 * Generates the bounded-agent skill document handed to the primary agent.
 *
 * The document is *guidance*, not a security boundary: every rule it states is
 * independently enforced by the `bounded-agent` wrapper and by the trusted
 * broker. Its job is to tell the agent which repositories exist (and at what
 * confidentiality budget), the request contract (repository + finite schema +
 * bounded task text), and the observable canonical result envelope.
 */

interface BoundedAgentSkillParams {
  /** Configured repositories, in configuration order. */
  repos: BoundedAgentRepository[];
  /** Per-invocation wall-clock limit, in seconds. */
  timeoutSeconds: number;
  /** Per-run invocation budget (an independent operational cap). */
  maxInvocations: number;
  /** Maximum size of the caller-supplied task text, in bytes. */
  maxTaskBytes: number;
  /** Trusted native coding-agent engine selected for the enclave. */
  engine: BoundedAgentsConfig['engine'];
}

function formatRunBudget(repo: BoundedAgentRepository): string {
  const bits = BOUNDED_AGENT_SENSITIVITY_RUN_BITS[repo.sensitivity];
  if (bits === null) return `unmetered (\`${repo.sensitivity}\`)`;
  if (bits === 0) return `0 bits/run (\`${repo.sensitivity}\` — never runs an enclave)`;
  return `${bits} bits/run (\`${repo.sensitivity}\`)`;
}

export function generateBoundedAgentSkill(params: BoundedAgentSkillParams): string {
  const { repos, timeoutSeconds, maxInvocations, maxTaskBytes, engine } = params;
  const repoList = repos.map((repo) => `- \`${repo.repo}\` — ${formatRunBudget(repo)}`).join('\n');
  const bucketList = TIMING_BUCKETS_MS.map((ms) => (ms >= 1000 ? `${ms / 1000}s` : `${ms}ms`)).join(', ');

  return `---
name: bounded-agent
description: >-
  Delegate a short, bounded task about one pre-approved private repository to
  an isolated enclave agent and get back a value conforming to a finite
  response schema you declare up front. Use when answering the question needs
  judgment or multi-step reading rather than a single deterministic script,
  and only when your remaining per-repository information budget can afford
  the answer's schema.
---

# Bounded agent

A bounded agent runs the configured native coding-agent engine inside a
single-use enclave. The enclave reads a read-only copy of exactly one
pre-approved private repository, reaches its configured model only through the
AWF API proxy, and must reduce its work to one value conforming to the finite
schema you declared.

The enclave has no host access, no credentials, no workspace access, no Squid
route, no general proxy, and no path to you, to the broker, to safe outputs, to
the MCP gateway, or to the CLI proxy. Its only reachable peer is the AWF API
proxy.

You never see the repository contents, the enclave's transcript, its tool
calls, its stdout/stderr, its files, its exit status, or any diagnostics. The
only thing you observe is one canonical JSON result:

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
bounded-agent \\
  --repo owner/repo \\
  --schema '{"type":"boolean"}' \\
  < task.txt
\`\`\`

Rules enforced by the CLI:

- exactly one \`--repo\`, and it must be one of the repositories listed above;
- exactly one \`--schema\`: a finite response schema (see below);
- the task text is read from stdin and must be at most ${maxTaskBytes} bytes;
- there are no other options. You cannot choose the image, command,
  executable, engine, model, provider, profile, tools, system prompt, runtime,
  timeout, mount, path, network, proxy, endpoint, resource limit, environment,
  or credentials. Supplying any of them is rejected.

The CLI always prints exactly one line of JSON and always exits \`0\`.

## Response schema

The schema is the same deliberately finite algebra bounded queries use — **not**
general JSON Schema. Supported node types:

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

There is no way to express an unbounded string, a float, a regex, recursion,
\`$ref\`, an optional field, \`additionalProperties\`, or an untagged/overlapping
union — these are structurally impossible, not merely disallowed. In
particular, **a bounded agent cannot return prose**: if you want a summary,
encode the finite set of conclusions you care about as an \`enum\`.

## Task contract

The task text is prompt input for the enclave, nothing else. It is never
interpreted as configuration: it cannot add a tool, change the model, reach a
network endpoint, or alter any limit.

Inside the enclave the configured native agent has its built-in tools, including
shell/Bash for the Copilot engine. The immutable seed remains read-only and all
writable state is bounded tmpfs. The \`${engine}\` engine reaches its fixed
model route through the AWF API proxy. Anything else in the output — wrong type,
out-of-range value,
unknown enum member, extra/missing fields, wrong length, malformed or
duplicate-key JSON, an oversized result, no result at all — is reported to you
as \`${CANONICAL_ERROR_JSON}\`.

## Budget

Every invocation reserves a fixed information charge from its repository's run
budget, computed **before** any workspace or container is created:

\`\`\`text
charge = ${RESULT_STATUS_BIT_COST} (ok/error) + ceil(log2(schema cardinality)) + ${TIMING_BUCKET_BITS} (timing)
\`\`\`

The charge is debited whether the enclave succeeds, fails, or times out, and is
never refunded. An invocation is only allowed if its charge fits the remaining
balance. The remaining balance itself is never disclosed to you.

Timing is charged because it is observable: the broker always returns at the
first bucket boundary at or after the enclave actually finishes (bucket
boundaries: ${bucketList}).

- Each invocation may run for at most ${timeoutSeconds} second(s).
- At most ${maxInvocations} invocation(s) are permitted for this entire run,
  independent of the bit budget above. Further calls return
  \`${CANONICAL_ERROR_JSON}\` without running anything.
- Bounded agents keep a ledger **separate** from bounded queries: spending here
  does not consume a bounded query's balance, and vice versa.

Design one high-value, low-cardinality question per invocation.
`;
}

/**
 * Writes the generated skill into the agent-visible artifact directory.
 *
 * The file is securely created 0600 under an AWF-owned directory, then made
 * 0644 for the agent's read-only bind mount. Nothing is written to the host
 * user's home directory or to the workspace.
 */
export function writeBoundedAgentSkill(paths: BoundedAgentPaths, params: BoundedAgentSkillParams): string {
  fs.mkdirSync(paths.agentDir, { recursive: true, mode: 0o755 });
  const content = generateBoundedAgentSkill(params);
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
