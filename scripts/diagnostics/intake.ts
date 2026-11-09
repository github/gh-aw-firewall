#!/usr/bin/env node
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { isCalendarDate } from './registry';

const WEEK = 7 * 86400_000;

function sanitizeForAgentText(value: string): string {
  const noControls = value.replace(/[\u0000-\u001f\u007f]/g, ' ');
  const neutralized = noControls
    .replace(/```/g, '`\\`\\`')
    .replace(/<\s*\/?\s*(system|assistant|user|tool)\s*>/gi, '[role-tag]')
    .replace(/\b(ignore|override|bypass|disregard)\b/gi, '[redacted]');
  return neutralized.trim().slice(0, 500);
}

export interface Candidate {
  number: number;
  title: string;
  html_url: string;
  updated_at: string;
}

function toSafeCandidate(candidate: Candidate): Candidate {
  return { ...candidate, title: sanitizeForAgentText(candidate.title) };
}

export interface IntakeState {
  version: 1;
  repository: string;
  since: string;
  historyBefore: string;
  historyFloor: string;
  pending: Candidate[];
}

export interface Receipt {
  number: number;
  updatedAt: string;
  disposition: 'covered' | 'proposed' | 'no-impact' | 'needs-evidence';
  evidence: string;
}

const instant = (value: string): number => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) ||
    !isCalendarDate(value.slice(0, 10)) || !Number.isFinite(Date.parse(value))) {
    throw new Error('Invalid intake timestamp');
  }
  return Date.parse(value);
};
const iso = (value: number): string => new Date(value).toISOString();

export function validateState(state: IntakeState, repository: string): void {
  if (state.version !== 1 || state.repository !== repository || !Array.isArray(state.pending)) {
    throw new Error('Invalid intake checkpoint or repository mismatch; do not silently reset it');
  }
  if (instant(state.historyFloor) > instant(state.historyBefore) ||
    instant(state.historyBefore) > instant(state.since)) throw new Error('Invalid intake cursor order');
  for (const candidate of state.pending) validateCandidate(candidate, repository);
}

function validateCandidate(candidate: Candidate, repository: string): void {
  if (!Number.isSafeInteger(candidate.number) || candidate.number < 1 ||
    typeof candidate.title !== 'string' ||
    candidate.html_url !== `https://github.com/${repository}/pull/${candidate.number}`) {
    throw new Error('Malformed merged-PR candidate');
  }
  instant(candidate.updated_at);
}

function projectCandidate(candidate: Candidate, repository: string): Candidate {
  validateCandidate(candidate, repository);
  const { number, title, html_url, updated_at } = candidate;
  return { number, title, html_url, updated_at };
}

export function validateReceipts(receipts: Receipt[]): void {
  if (!Array.isArray(receipts)) throw new Error('Intake receipts must be an array');
  for (const receipt of receipts) {
    if (!Number.isSafeInteger(receipt.number) || receipt.number < 1 ||
      !['covered', 'proposed', 'no-impact', 'needs-evidence'].includes(receipt.disposition) ||
      typeof receipt.evidence !== 'string' || receipt.evidence.trim().length < 12) {
      throw new Error('Every intake receipt requires a disposition and specific review evidence');
    }
    instant(receipt.updatedAt);
  }
}

/** Fetch complete windows before advancing cursors; retrieval is not diagnosis completion. */
export async function collectIntake(
  state: IntakeState,
  receipts: Receipt[],
  fetchWindow: (since: string, until: string) => Promise<Candidate[]>,
  now: string,
): Promise<IntakeState> {
  validateState(state, state.repository);
  validateReceipts(receipts);
  if (instant(now) < instant(state.since)) throw new Error('Intake clock precedes checkpoint');
  const pending = new Map(state.pending.map((candidate) =>
    [candidate.number, projectCandidate(candidate, state.repository)]));
  const add = (candidates: Candidate[]): void => {
    for (const candidate of candidates) {
      validateCandidate(candidate, state.repository);
      const previous = pending.get(candidate.number);
      if (!previous || instant(candidate.updated_at) >= instant(previous.updated_at)) {
        pending.set(candidate.number, projectCandidate(candidate, state.repository));
      }
    }
  };
  const since = iso(Math.min(instant(state.since) + WEEK, instant(now)));
  add(await fetchWindow(state.since, since));
  // Catch up older merges without starving the current feed or growing an unbounded active batch.
  let historyBefore = state.historyBefore;
  if (pending.size < 100 && instant(historyBefore) > instant(state.historyFloor)) {
    const start = iso(Math.max(instant(state.historyFloor), instant(historyBefore) - WEEK));
    add(await fetchWindow(start, historyBefore));
    historyBefore = start;
  }
  for (const receipt of receipts) {
    const candidate = pending.get(receipt.number);
    if (candidate?.updated_at === receipt.updatedAt && receipt.disposition !== 'needs-evidence') {
      pending.delete(receipt.number);
    }
  }
  return {
    ...state, since, historyBefore,
    pending: [...pending.values()].sort((a, b) =>
      a.updated_at.localeCompare(b.updated_at) || a.number - b.number),
  };
}

function api<T>(args: string[]): T {
  return JSON.parse(execFileSync('gh', ['api', '--method', 'GET', ...args], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  })) as T;
}

export function readIntakeJson<T>(file: string): T {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024) {
      throw new Error('Intake cache must contain bounded, single-link regular JSON files');
    }
    try {
      return JSON.parse(fs.readFileSync(descriptor, 'utf8')) as T;
    } catch {
      throw new Error('Intake cache JSON is unreadable or malformed; checkpoint not advanced');
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

export async function fetchMergedWindow(repository: string, since: string, until: string): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  let total = 0;
  for (let page = 1; page <= 10; page++) {
    const response = api<{ total_count: number; incomplete_results: boolean; items: Candidate[] }>([
      'search/issues', '-f', `q=repo:${repository} is:pr is:merged merged:${since}..${until}`,
      '-f', 'sort=created', '-f', 'order=asc', '-f', 'per_page=100', '-f', `page=${page}`,
    ]);
    if (response.incomplete_results || response.total_count > 1000) {
      throw new Error('Merged-PR search is incomplete or exceeds 1000 results; checkpoint not advanced');
    }
    total = response.total_count;
    candidates.push(...response.items.map((candidate) => projectCandidate(candidate, repository)));
    if (candidates.length >= total) break;
  }
  if (new Set(candidates.map((candidate) => candidate.number)).size !== total) {
    throw new Error('Merged-PR pagination changed during collection; retry without advancing checkpoint');
  }
  return candidates;
}

async function main(): Promise<void> {
  const [stateDir, outputDir] = process.argv.slice(2);
  if (!stateDir || !outputDir || process.argv.length !== 4) {
    throw new Error('Usage: intake.ts <cache-directory> <output-directory>');
  }
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('GITHUB_REPOSITORY is required');
  for (const directory of [stateDir, outputDir]) {
    fs.mkdirSync(directory, { recursive: true });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Intake directories must not be symlinks');
  }
  const now = new Date().toISOString();
  const statePath = path.join(stateDir, 'intake.json');
  const receiptsPath = path.join(stateDir, 'receipts.json');
  let state: IntakeState;
  if (fs.existsSync(statePath)) {
    state = readIntakeJson<IntakeState>(statePath);
    validateState(state, repository);
  } else {
    const repo = api<{ created_at: string }>([`repos/${repository}`]);
    const since = iso(Math.max(instant(repo.created_at), instant(now) - WEEK));
    state = {
      version: 1, repository, since, historyBefore: since, historyFloor: repo.created_at, pending: [],
    };
  }
  const receipts = fs.existsSync(receiptsPath)
    ? readIntakeJson<Receipt[]>(receiptsPath) : [];
  const collected = await collectIntake(state, receipts,
    (since, until) => fetchMergedWindow(repository, since, until), now);
  fs.writeFileSync(path.join(outputDir, 'scan-since.txt'), `${state.since}\n`);
  const safeForAgents = {
    ...collected,
    pending: collected.pending.map(toSafeCandidate),
  };
  fs.writeFileSync(path.join(outputDir, 'candidates.json'), JSON.stringify(safeForAgents, null, 2) + '\n');
  fs.writeFileSync(`${statePath}.tmp`, JSON.stringify(collected, null, 2) + '\n', { flag: 'wx' });
  fs.renameSync(`${statePath}.tmp`, statePath);
  console.log(`Collected ${collected.pending.length} unclassified/deferred merges; forward=${collected.since}; historical=${collected.historyBefore}`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
