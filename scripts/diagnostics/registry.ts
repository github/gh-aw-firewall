/**
 * Shared diagnosis primitives for the canonical AWF diagnosis registry.
 *
 * The registry lives in `docs/diagnostics/` and is the single source of truth
 * for AWF diagnosis knowledge. This module implements the documented
 * primitives used by tooling, tests and CI:
 *
 * - `loadFindings()`  - deterministic load of every canonical record
 * - `validateFindings()` - schema, ID, provenance and safety validation
 * - `searchFindings()` - bounded lookup by symptom text and topology
 * - `renderOutputs()` - deterministic generated artifacts
 * - `checkSync()`     - parity between canonical state and generated files
 */

import * as fs from 'fs';
import * as path from 'path';
import Ajv2020 from 'ajv/dist/2020';

export const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Repository-relative paths - the single source of truth for registry layout. */
export const REGISTRY_RELATIVE_DIR = 'docs/diagnostics';
export const FINDINGS_RELATIVE_DIR = `${REGISTRY_RELATIVE_DIR}/findings`;
export const SCHEMA_RELATIVE_PATH = `${REGISTRY_RELATIVE_DIR}/schema.json`;
export const PLAYBOOK_RELATIVE_PATH = `${REGISTRY_RELATIVE_DIR}/agent-playbook.md`;
export const README_RELATIVE_PATH = `${REGISTRY_RELATIVE_DIR}/README.md`;
export const WORKFLOW_CATALOG_RELATIVE_PATH = '.github/workflows/shared/diagnosis-findings.md';
export const PORTABLE_AGENT_RELATIVE_PATH = '.github/agents/diagnose-awf.md';

/** Absolute paths for the checked-out repository. */
export const REGISTRY_DIR = path.join(REPO_ROOT, REGISTRY_RELATIVE_DIR);
export const FINDINGS_DIR = path.join(REPO_ROOT, FINDINGS_RELATIVE_DIR);
export const SCHEMA_PATH = path.join(REPO_ROOT, SCHEMA_RELATIVE_PATH);
export const PLAYBOOK_PATH = path.join(REPO_ROOT, PLAYBOOK_RELATIVE_PATH);
export const README_PATH = path.join(REPO_ROOT, README_RELATIVE_PATH);
export const WORKFLOW_CATALOG_PATH = path.join(REPO_ROOT, WORKFLOW_CATALOG_RELATIVE_PATH);
export const PORTABLE_AGENT_PATH = path.join(REPO_ROOT, PORTABLE_AGENT_RELATIVE_PATH);

export const GENERATED_MARKER_BEGIN = '<!-- BEGIN GENERATED: docs/diagnostics/findings -->';
export const GENERATED_MARKER_END = '<!-- END GENERATED: docs/diagnostics/findings -->';

/** Boundaries in the order they are rendered. */
export const BOUNDARIES = ['runner', 'runtime', 'network', 'auth', 'ci', 'security'] as const;
export type Boundary = (typeof BOUNDARIES)[number];

/** ID namespace allowed per boundary. Runner keeps the historical A/B/C/D IDs. */
const BOUNDARY_ID_PATTERN: Record<Boundary, RegExp> = {
  runner: /^[A-D][0-9]{1,3}$/,
  runtime: /^RT-[0-9]{3}$/,
  network: /^NET-[0-9]{3}$/,
  auth: /^AUTH-[0-9]{3}$/,
  ci: /^CI-[0-9]{3}$/,
  security: /^SEC-[0-9]{3}$/,
};

export interface FindingReference {
  kind: 'issue' | 'pull-request' | 'doc' | 'code' | 'test';
  ref: string;
  title?: string;
}

export interface Finding {
  id: string;
  boundary: Boundary;
  title: string;
  symptoms: string[];
  conditions: string[];
  affects: { runner: string; runtime: string; provider: string; authMode: string };
  versions: { introduced: string; fixed: string };
  status: 'fixed' | 'workaround' | 'unresolved' | 'needs-evidence' | 'superseded';
  supersededBy?: string;
  rootCause: string;
  probe: { command: string; expect: string; readOnly: true; secretSafe: true };
  action: string;
  references: FindingReference[];
  related?: string[];
  owner: string;
  reviewBy: string;
}

export interface LoadedFinding {
  finding: Finding;
  /** Repository-relative source path of the canonical record. */
  source: string;
}

/**
 * Patterns that must never appear in a finding. They cover credential values,
 * environment dumps, token exchanges and isolation bypasses.
 */
const UNSAFE_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\bghp_[A-Za-z0-9]{8,}/, reason: 'looks like a GitHub token value' },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{8,}/, reason: 'looks like a fine-grained PAT value' },
  { pattern: /\bsk-[A-Za-z0-9]{12,}/, reason: 'looks like an API key value' },
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\./, reason: 'looks like a JWT value' },
];

/** Probe commands must not dump environments, exchange tokens or bypass isolation. */
const UNSAFE_PROBE_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /(^|[^-\w])(env|printenv)(\s|$)/, reason: 'dumps the environment' },
  { pattern: /--env-all/, reason: 'requests an isolation bypass' },
  { pattern: /authorization:/i, reason: 'prints an Authorization header' },
  { pattern: /\bcurl\b[^\n]*\b(token|oauth|oidc)\b/i, reason: 'performs a token exchange' },
  { pattern: /\.netrc|id_rsa|\.ssh\//, reason: 'reads credential material' },
  { pattern: /\$\{?(GITHUB_TOKEN|COPILOT_GITHUB_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY)/, reason: 'expands a credential variable' },
];

/** Actions must not recommend disabling isolation. */
const UNSAFE_ACTION_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /--env-all/, reason: 'recommends exposing the full environment' },
  { pattern: /disable (the )?(firewall|isolation|egress filtering)/i, reason: 'recommends disabling isolation' },
  { pattern: /allow[- ]domains\s+['"]?\*/, reason: 'recommends a wildcard allowlist' },
];

function boundaryRank(boundary: string): number {
  const index = (BOUNDARIES as readonly string[]).indexOf(boundary);
  return index === -1 ? BOUNDARIES.length : index;
}

/** Deterministic ordering: boundary order, then ID. */
export function compareFindings(a: Finding, b: Finding): number {
  const rank = boundaryRank(a.boundary) - boundaryRank(b.boundary);
  if (rank !== 0) return rank;
  return a.id.localeCompare(b.id, 'en');
}

/** Load every canonical record, deterministically ordered. */
export function loadFindings(findingsDir: string = FINDINGS_DIR): LoadedFinding[] {
  const loaded: LoadedFinding[] = [];
  if (!fs.existsSync(findingsDir)) return loaded;

  for (const boundaryDir of fs.readdirSync(findingsDir).sort()) {
    const dir = path.join(findingsDir, boundaryDir);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const file of fs.readdirSync(dir).sort()) {
      if (!file.endsWith('.json')) continue;
      const full = path.join(dir, file);
      const finding = JSON.parse(fs.readFileSync(full, 'utf8')) as Finding;
      loaded.push({ finding, source: path.relative(REPO_ROOT, full).split(path.sep).join('/') });
    }
  }

  return loaded.sort((a, b) => compareFindings(a.finding, b.finding));
}

/**
 * Validate the registry: schema conformance, unique/namespaced IDs, required
 * provenance, reference shape, status/version consistency and safety rules.
 * Returns a list of human-readable errors (empty when valid).
 */
export function validateFindings(
  loaded: LoadedFinding[],
  options: { repoRoot?: string; schemaPath?: string } = {}
): string[] {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const schema = JSON.parse(fs.readFileSync(options.schemaPath ?? SCHEMA_PATH, 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);

  const errors: string[] = [];
  const seen = new Map<string, string>();
  const ids = new Set(loaded.map((entry) => entry.finding.id));

  for (const { finding, source } of loaded) {
    const prefix = `${source}`;

    if (!validate(finding)) {
      for (const error of validate.errors ?? []) {
        errors.push(`${prefix}: schema error at ${error.instancePath || '/'} ${error.message}`);
      }
      continue;
    }

    const expectedDir = `docs/diagnostics/findings/${finding.boundary}/${finding.id}.json`;
    if (source !== expectedDir) {
      errors.push(`${prefix}: record must be stored at ${expectedDir}`);
    }

    const previous = seen.get(finding.id);
    if (previous) {
      errors.push(`${prefix}: duplicate finding ID ${finding.id} (also defined in ${previous})`);
    }
    seen.set(finding.id, source);

    const idPattern = BOUNDARY_ID_PATTERN[finding.boundary];
    if (!idPattern.test(finding.id)) {
      errors.push(
        `${prefix}: ID ${finding.id} is not in the ${finding.boundary} namespace (${idPattern})`
      );
    }

    if (finding.status === 'fixed' && finding.versions.fixed === 'unknown') {
      // A 'fixed' status without a verified version scope must still cite the
      // merged implementation; an open PR or provider doc is not enough.
      const hasShippedProvenance = finding.references.some(
        (reference) => reference.kind === 'code' || reference.kind === 'test'
      );
      if (!hasShippedProvenance) {
        errors.push(
          `${prefix}: status 'fixed' requires versions.fixed or an implementation/test citation`
        );
      }
    }

    if (finding.status === 'superseded' && !finding.supersededBy) {
      errors.push(`${prefix}: status 'superseded' requires supersededBy`);
    }
    if (finding.supersededBy && !ids.has(finding.supersededBy)) {
      errors.push(`${prefix}: supersededBy references unknown finding ${finding.supersededBy}`);
    }

    for (const related of finding.related ?? []) {
      if (related === finding.id) {
        errors.push(`${prefix}: related must not reference itself`);
      } else if (!ids.has(related)) {
        errors.push(`${prefix}: related references unknown finding ${related}`);
      }
    }

    if (!finding.references.some((reference) => reference.kind !== 'doc')) {
      errors.push(
        `${prefix}: requires at least one issue, pull-request, code or test provenance reference`
      );
    }

    for (const reference of finding.references) {
      if (reference.ref.startsWith('http://')) {
        errors.push(`${prefix}: reference ${reference.ref} must use https`);
        continue;
      }
      if (reference.ref.startsWith('https://')) continue;
      const target = reference.ref.split('#')[0];
      if (!fs.existsSync(path.join(repoRoot, target))) {
        errors.push(`${prefix}: reference path ${target} does not exist`);
      }
    }

    const scannable = JSON.stringify(finding);
    for (const { pattern, reason } of UNSAFE_PATTERNS) {
      if (pattern.test(scannable)) {
        errors.push(`${prefix}: unsafe content - ${reason}`);
      }
    }
    for (const { pattern, reason } of UNSAFE_PROBE_PATTERNS) {
      if (pattern.test(finding.probe.command)) {
        errors.push(`${prefix}: unsafe probe - ${reason}`);
      }
    }
    for (const { pattern, reason } of UNSAFE_ACTION_PATTERNS) {
      if (pattern.test(finding.action)) {
        errors.push(`${prefix}: unsafe action - ${reason}`);
      }
    }
  }

  return errors;
}

export interface SearchQuery {
  /** Free-form symptom text, for example a pasted error string. */
  text?: string;
  boundary?: string;
  runner?: string;
  runtime?: string;
  provider?: string;
  authMode?: string;
  /** Maximum number of matches to return (bounded lookup). Defaults to 5. */
  limit?: number;
}

export interface SearchMatch {
  id: string;
  boundary: Boundary;
  title: string;
  score: number;
  source: string;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Tokenize for fuzzy symptom overlap, ignoring punctuation. */
function tokenize(value: string, minLength: number): string[] {
  return normalize(value)
    .split(/[^a-z0-9_-]+/)
    .filter((word) => word.length > minLength);
}

function dimensionScore(findingValue: string, queryValue?: string): number {
  if (!queryValue) return 0;
  const target = normalize(findingValue);
  if (target === 'any') return 0;
  const query = normalize(queryValue);
  if (target === 'unknown') return 0;
  return target.split('|').some((option) => option === query || query.includes(option)) ? 2 : -3;
}

/**
 * Bounded lookup by symptom signature and topology dimensions. Returns matches
 * ordered by descending score; an empty result means "no record matched" and
 * the caller must collect evidence rather than invent a fix.
 */
export function searchFindings(loaded: LoadedFinding[], query: SearchQuery): SearchMatch[] {
  const text = query.text ? normalize(query.text) : '';
  const matches: SearchMatch[] = [];

  for (const { finding, source } of loaded) {
    if (query.boundary && finding.boundary !== query.boundary) continue;
    if (finding.status === 'superseded') continue;

    let score = 0;
    if (text) {
      for (const symptom of finding.symptoms) {
        const normalized = normalize(symptom);
        if (text.includes(normalized)) {
          score += 5;
          continue;
        }
        const words = tokenize(normalized, 3);
        const overlap = words.filter((word) => text.includes(word)).length;
        if (words.length > 0 && overlap / words.length >= 0.6) score += 3;
      }
      for (const condition of finding.conditions) {
        const words = tokenize(condition, 5);
        const overlap = words.filter((word) => text.includes(word)).length;
        if (words.length > 0 && overlap / words.length >= 0.5) score += 1;
      }
    }

    score += dimensionScore(finding.affects.runner, query.runner);
    score += dimensionScore(finding.affects.runtime, query.runtime);
    score += dimensionScore(finding.affects.provider, query.provider);
    score += dimensionScore(finding.affects.authMode, query.authMode);

    if (score > 0) {
      matches.push({ id: finding.id, boundary: finding.boundary, title: finding.title, score, source });
    }
  }

  return matches
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id, 'en'))
    .slice(0, query.limit ?? 5);
}

function referenceLabel(reference: FindingReference): string {
  const title = reference.title ? `${reference.title} (${reference.ref})` : reference.ref;
  return `${reference.kind}: ${title}`;
}

function renderFinding(finding: Finding): string {
  const lines: string[] = [];
  lines.push(`### ${finding.id} — ${finding.title}`);
  lines.push('');
  lines.push(
    `- **Boundary:** ${finding.boundary} · **Status:** ${finding.status}` +
      (finding.supersededBy ? ` (superseded by ${finding.supersededBy})` : '')
  );
  lines.push(
    `- **Affects:** runner=${finding.affects.runner}, runtime=${finding.affects.runtime}, ` +
      `provider=${finding.affects.provider}, auth=${finding.affects.authMode}`
  );
  lines.push(
    `- **Versions:** introduced=${finding.versions.introduced}, fixed=${finding.versions.fixed}`
  );
  lines.push(`- **Symptoms:** ${finding.symptoms.join(' · ')}`);
  lines.push(`- **Discriminating conditions:** ${finding.conditions.join(' · ')}`);
  lines.push(`- **Root cause:** ${finding.rootCause}`);
  lines.push(`- **Safe probe:** \`${finding.probe.command}\` → ${finding.probe.expect}`);
  lines.push(`- **Action:** ${finding.action}`);
  if (finding.related && finding.related.length > 0) {
    lines.push(`- **Related:** ${finding.related.join(', ')}`);
  }
  lines.push(`- **Provenance:** ${finding.references.map(referenceLabel).join(' · ')}`);
  lines.push(`- **Owner:** ${finding.owner} · **Review by:** ${finding.reviewBy}`);
  lines.push('');
  return lines.join('\n');
}

/** Deterministic catalog body shared by every generated consumer. */
export function renderCatalog(loaded: LoadedFinding[]): string {
  const lines: string[] = [];
  for (const boundary of BOUNDARIES) {
    const entries = loaded.filter((entry) => entry.finding.boundary === boundary);
    if (entries.length === 0) continue;
    lines.push(`## Boundary: ${boundary}`);
    lines.push('');
    for (const entry of entries) {
      lines.push(renderFinding(entry.finding));
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

/** Escape a value for a Markdown table cell (backslashes first, then pipes). */
function escapeTableCell(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

/** Deterministic symptom → finding lookup table. */
export function renderLookupTable(loaded: LoadedFinding[]): string {
  const rows: string[] = ['| Observable symptom | Finding | Boundary | Status |', '|---|---|---|---|'];
  for (const { finding } of loaded) {
    for (const symptom of finding.symptoms) {
      rows.push(
        `| ${escapeTableCell(symptom)} | ${finding.id} | ${finding.boundary} | ${finding.status} |`
      );
    }
  }
  return rows.join('\n');
}

const GENERATED_HEADER = [
  '<!-- Generated from docs/diagnostics/findings by scripts/diagnostics/cli.ts render. Do not edit by hand. -->',
].join('\n');

function renderWorkflowCatalog(loaded: LoadedFinding[]): string {
  return [
    '# AWF Diagnosis Findings',
    '',
    GENERATED_HEADER,
    '',
    'Canonical source: [`docs/diagnostics/`](../../../docs/diagnostics/README.md).',
    'Match the narrowest finding ID. When nothing matches, say so and request the smallest read-only probe.',
    '',
    '## Symptom lookup',
    '',
    renderLookupTable(loaded),
    '',
    renderCatalog(loaded),
    '',
  ].join('\n');
}

function renderPortableAgent(loaded: LoadedFinding[], playbook: string): string {
  return [
    playbook.trimEnd(),
    '',
    GENERATED_MARKER_BEGIN,
    '',
    GENERATED_HEADER,
    '',
    '## Symptom lookup',
    '',
    renderLookupTable(loaded),
    '',
    renderCatalog(loaded),
    '',
    GENERATED_MARKER_END,
    '',
  ].join('\n');
}

function renderIndexSection(loaded: LoadedFinding[]): string {
  const lines: string[] = [];
  lines.push('| Finding | Boundary | Title | Status | Record |');
  lines.push('|---|---|---|---|---|');
  for (const { finding, source } of loaded) {
    const relative = source.replace('docs/diagnostics/', '');
    lines.push(
      `| ${finding.id} | ${finding.boundary} | ${finding.title} | ${finding.status} | [\`${relative}\`](./${relative}) |`
    );
  }
  lines.push('');
  lines.push('### Symptom lookup');
  lines.push('');
  lines.push(renderLookupTable(loaded));
  return lines.join('\n');
}

/** Replace the generated block of an authored file, preserving human content. */
export function replaceGeneratedBlock(existing: string, generated: string): string {
  const begin = existing.indexOf(GENERATED_MARKER_BEGIN);
  const end = existing.indexOf(GENERATED_MARKER_END);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(
      `Missing generated markers (${GENERATED_MARKER_BEGIN} / ${GENERATED_MARKER_END})`
    );
  }
  const head = existing.slice(0, begin + GENERATED_MARKER_BEGIN.length);
  const tail = existing.slice(end);
  return `${head}\n\n${generated}\n\n${tail}`;
}

export interface GeneratedOutput {
  /** Repository-relative path of the generated artifact. */
  path: string;
  content: string;
}

/**
 * Deterministically render every generated consumer of the registry:
 * the gh-aw runtime-importable catalog, the portable agent knowledge section,
 * and the navigation index inside the registry README.
 */
export function renderOutputs(
  loaded: LoadedFinding[],
  options: { repoRoot?: string } = {}
): GeneratedOutput[] {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const playbook = fs.readFileSync(path.join(repoRoot, PLAYBOOK_RELATIVE_PATH), 'utf8');
  const readme = fs.readFileSync(path.join(repoRoot, README_RELATIVE_PATH), 'utf8');

  return [
    {
      path: WORKFLOW_CATALOG_RELATIVE_PATH,
      content: renderWorkflowCatalog(loaded),
    },
    {
      path: PORTABLE_AGENT_RELATIVE_PATH,
      content: renderPortableAgent(loaded, playbook),
    },
    {
      path: README_RELATIVE_PATH,
      content: replaceGeneratedBlock(readme, renderIndexSection(loaded)),
    },
  ];
}

export interface SyncResult {
  /** Repository-relative paths whose content differs from the canonical render. */
  stale: string[];
}

/** Fail-closed parity check between canonical state and generated artifacts. */
export function checkSync(
  loaded: LoadedFinding[],
  options: { repoRoot?: string } = {}
): SyncResult {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const stale: string[] = [];
  for (const output of renderOutputs(loaded, options)) {
    const full = path.join(repoRoot, output.path);
    const current = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
    if (current !== output.content) stale.push(output.path);
  }
  return { stale };
}

/** Write generated artifacts to disk. */
export function writeOutputs(loaded: LoadedFinding[], options: { repoRoot?: string } = {}): string[] {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const written: string[] = [];
  for (const output of renderOutputs(loaded, options)) {
    const full = path.join(repoRoot, output.path);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, output.content);
    written.push(output.path);
  }
  return written;
}
