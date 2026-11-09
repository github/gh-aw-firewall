#!/usr/bin/env node
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { isCalendarDate } from './registry';

const WEEK = 7 * 86400_000;
const DEFERRED_REVIEW_LIMIT = 10;

export function sanitizeForAgentText(value: string): string {
  const noControls = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? ' ' : character;
  }).join('');
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
  updatedSince?: string;
  historyBefore: string;
  historyFloor: string;
  deferredCursor?: number;
  pending: Candidate[];
}

export interface Receipt {
  number: number;
  updatedAt: string;
  disposition: 'covered' | 'proposed' | 'no-impact' | 'needs-evidence';
  evidence: string;
}

export interface ReviewQueue {
  firstTime: Candidate[];
  deferred: Candidate[];
  deferredCount: number;
}

export interface IntakeCollection extends IntakeState {
  reviewQueue: ReviewQueue;
}

class MalformedIntakeJsonError extends Error {}

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
  if (state.updatedSince !== undefined) instant(state.updatedSince);
  if (state.deferredCursor !== undefined &&
    (!Number.isSafeInteger(state.deferredCursor) || state.deferredCursor < 1)) {
    throw new Error('Invalid deferred review cursor');
  }
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

function isValidReceipt(value: unknown): value is Receipt {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as Partial<Receipt>;
  if (!Number.isSafeInteger(receipt.number) || (receipt.number ?? 0) < 1 ||
    !['covered', 'proposed', 'no-impact', 'needs-evidence'].includes(receipt.disposition ?? '') ||
    typeof receipt.evidence !== 'string' || receipt.evidence.trim().length < 12 ||
    typeof receipt.updatedAt !== 'string') return false;
  try {
    instant(receipt.updatedAt);
    return true;
  } catch {
    return false;
  }
}

export function readReceipts(file: string): Receipt[] {
  let value: unknown;
  try {
    value = readIntakeJson<unknown>(file);
  } catch (error) {
    if (!(error instanceof MalformedIntakeJsonError)) throw error;
    fs.unlinkSync(file);
    console.warn('Malformed intake receipts were discarded; affected candidates will be reviewed again.');
    return [];
  }
  if (!Array.isArray(value)) {
    fs.unlinkSync(file);
    console.warn('Invalid intake receipt data was discarded; affected candidates will be reviewed again.');
    return [];
  }
  const receipts = value.filter(isValidReceipt);
  const invalidCount = value.length - receipts.length;
  if (invalidCount > 0) {
    console.warn(`Ignored ${invalidCount} invalid intake receipt(s); affected candidates remain pending.`);
  }
  return receipts;
}

/** Fetch complete windows before advancing cursors; retrieval is not diagnosis completion. */
export async function collectIntake(
  state: IntakeState,
  receipts: Receipt[],
  fetchWindow: (since: string, until: string) => Promise<Candidate[]>,
  now: string,
  fetchUpdatedWindow: (since: string, until: string) => Promise<Candidate[]> = async () => [],
): Promise<IntakeCollection> {
  validateState(state, state.repository);
  validateReceipts(receipts);
  if (instant(now) < instant(state.since)) throw new Error('Intake clock precedes checkpoint');
  const previousUpdatedSince = state.updatedSince ?? state.since;
  if (instant(now) < instant(previousUpdatedSince)) throw new Error('Intake clock precedes update checkpoint');
  const receiptStatus = new Map<string, { completed: boolean; needsEvidence: boolean }>();
  for (const receipt of receipts) {
    const key = `${receipt.number}:${receipt.updatedAt}`;
    const status = receiptStatus.get(key) ?? { completed: false, needsEvidence: false };
    if (receipt.disposition === 'needs-evidence') status.needsEvidence = true;
    else status.completed = true;
    receiptStatus.set(key, status);
  }
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
  const firstTimeCount = [...pending.values()].filter((candidate) =>
    !receiptStatus.has(`${candidate.number}:${candidate.updated_at}`)).length;
  if (firstTimeCount < 100 && instant(historyBefore) > instant(state.historyFloor)) {
    const start = iso(Math.max(instant(state.historyFloor), instant(historyBefore) - WEEK));
    add(await fetchWindow(start, historyBefore));
    historyBefore = start;
  }
  const updatedSince = iso(Math.min(instant(previousUpdatedSince) + WEEK, instant(now)));
  if (instant(updatedSince) > instant(previousUpdatedSince)) {
    add(await fetchUpdatedWindow(previousUpdatedSince, updatedSince));
  }
  for (const [number, candidate] of pending) {
    const status = receiptStatus.get(`${number}:${candidate.updated_at}`);
    if (status?.completed) pending.delete(number);
  }
  const allPending = [...pending.values()].sort((a, b) =>
    a.updated_at.localeCompare(b.updated_at) || a.number - b.number);
  const deferred = allPending.filter((candidate) =>
    receiptStatus.get(`${candidate.number}:${candidate.updated_at}`)?.needsEvidence);
  const firstTime = allPending.filter((candidate) => !deferred.includes(candidate));
  const deferredCursorIndex = state.deferredCursor === undefined
    ? -1 : deferred.findIndex(({ number }) => number === state.deferredCursor);
  const deferredStart = deferred.length === 0 ? 0 : (deferredCursorIndex + 1) % deferred.length;
  const rotatedDeferred = deferred.length === 0 ? [] : [
    ...deferred.slice(deferredStart), ...deferred.slice(0, deferredStart),
  ];
  const deferredReview = rotatedDeferred.slice(0, DEFERRED_REVIEW_LIMIT);
  return {
    ...state, since, updatedSince, historyBefore,
    deferredCursor: deferredReview.length > 0
      ? deferredReview[deferredReview.length - 1].number
      : state.deferredCursor,
    pending: allPending,
    reviewQueue: {
      firstTime,
      deferred: deferredReview,
      deferredCount: deferred.length,
    },
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
      throw new MalformedIntakeJsonError('Intake cache JSON is unreadable or malformed; checkpoint not advanced');
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

export async function fetchMergedWindow(repository: string, since: string, until: string): Promise<Candidate[]> {
  return fetchPrWindow(repository, `merged:${since}..${until}`, 'created');
}

export async function fetchUpdatedWindow(repository: string, since: string, until: string): Promise<Candidate[]> {
  return fetchPrWindow(repository, `updated:${since}..${until}`, 'updated');
}

async function fetchPrWindow(
  repository: string,
  dateFilter: string,
  sort: 'created' | 'updated',
): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  let total = 0;
  for (let page = 1; page <= 10; page++) {
    const response = api<{ total_count: number; incomplete_results: boolean; items: Candidate[] }>([
      'search/issues', '-f', `q=repo:${repository} is:pr is:merged ${dateFilter}`,
      '-f', `sort=${sort}`, '-f', 'order=asc', '-f', 'per_page=100', '-f', `page=${page}`,
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
      version: 1, repository, since, updatedSince: since,
      historyBefore: since, historyFloor: repo.created_at, pending: [],
    };
  }
  const receipts = fs.existsSync(receiptsPath) ? readReceipts(receiptsPath) : [];
  const collected = await collectIntake(state, receipts,
    (since, until) => fetchMergedWindow(repository, since, until), now,
    (since, until) => fetchUpdatedWindow(repository, since, until));
  fs.writeFileSync(path.join(outputDir, 'scan-since.txt'), `${state.since}\n`);
  const { reviewQueue, ...checkpointState } = collected;
  const safeForAgents = {
    ...checkpointState,
    pending: checkpointState.pending.map(toSafeCandidate),
    reviewQueue: {
      firstTime: reviewQueue.firstTime.map(toSafeCandidate),
      deferred: reviewQueue.deferred.map(toSafeCandidate),
      deferredCount: reviewQueue.deferredCount,
    },
  };
  fs.writeFileSync(path.join(outputDir, 'candidates.json'), JSON.stringify(safeForAgents, null, 2) + '\n');
  fs.writeFileSync(`${statePath}.tmp`, JSON.stringify(checkpointState, null, 2) + '\n', { flag: 'wx' });
  fs.renameSync(`${statePath}.tmp`, statePath);
  console.log(`Collected ${collected.pending.length} unclassified/deferred merges; forward=${collected.since}; updated=${collected.updatedSince}; historical=${collected.historyBefore}`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Intake failed');
    process.exitCode = 1;
  });
}
