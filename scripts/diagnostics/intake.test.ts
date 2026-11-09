import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { collectIntake, fetchMergedWindow, IntakeState, readIntakeJson, Receipt, validateState } from './intake';

jest.mock('child_process', () => ({ execFileSync: jest.fn() }));
const exec = jest.mocked(execFileSync);
const repository = 'github/gh-aw-firewall';
const candidate = (number: number, updated_at = '2026-11-08T00:00:00Z') => ({
  number, title: 'Unhelpful title without diagnosis keywords',
  html_url: `https://github.com/${repository}/pull/${number}`, updated_at,
});
const checkpoint = (): IntakeState => ({
  version: 1, repository, since: '2026-11-01T00:00:00.000Z',
  historyBefore: '2026-11-01T00:00:00.000Z', historyFloor: '2026-10-20T00:00:00Z', pending: [],
});
const now = '2026-11-09T00:00:00Z';

describe('diagnosis merged intake', () => {
  beforeEach(() => exec.mockReset());

  it('catches up missed runs and traverses a separate historical window without keyword filtering', async () => {
    const fetch = jest.fn().mockResolvedValueOnce([candidate(1)]).mockResolvedValueOnce([candidate(2)]);
    const state = await collectIntake(checkpoint(), [], fetch, now);
    expect(fetch.mock.calls).toEqual([
      ['2026-11-01T00:00:00.000Z', '2026-11-08T00:00:00.000Z'],
      ['2026-10-25T00:00:00.000Z', '2026-11-01T00:00:00.000Z'],
    ]);
    expect(state.pending.map(({ number }) => number)).toEqual([1, 2]);
    expect(state.since).toBe('2026-11-08T00:00:00.000Z');
    expect(state.historyBefore).toBe('2026-10-25T00:00:00.000Z');
  });

  it('does not mutate or advance the checkpoint after partial fetch failure', async () => {
    const state = checkpoint();
    const original = JSON.stringify(state);
    const fetch = jest.fn().mockResolvedValueOnce([candidate(1)]).mockRejectedValueOnce(new Error('API down'));
    await expect(collectIntake(state, [], fetch, now)).rejects.toThrow('API down');
    expect(JSON.stringify(state)).toBe(original);
  });

  it('deduplicates inclusive window boundaries and retains the newest candidate revision', async () => {
    const state = checkpoint();
    state.pending = [candidate(1)];
    const fetch = jest.fn().mockResolvedValueOnce([candidate(1, '2026-11-09T00:00:00Z')])
      .mockResolvedValueOnce([candidate(1)]);
    const result = await collectIntake(state, [], fetch, now);
    expect(result.pending).toEqual([candidate(1, '2026-11-09T00:00:00Z')]);
  });

  it('keeps deferred and changed candidates pending but consumes exact reviewed receipts', async () => {
    const state = checkpoint();
    state.pending = [candidate(1), candidate(2), candidate(3)];
    const receipt = (number: number, disposition: Receipt['disposition'], updatedAt = candidate(1).updated_at): Receipt =>
      ({ number, updatedAt, disposition, evidence: 'CI-001 and current contract tests reviewed' });
    const result = await collectIntake(state, [
      receipt(1, 'covered'), receipt(2, 'needs-evidence'),
      receipt(3, 'proposed', '2026-11-07T00:00:00Z'),
    ], async () => [], now);
    expect(result.pending.map(({ number }) => number)).toEqual([2, 3]);
  });

  it('pauses historical catchup for a large backlog without starving the forward feed', async () => {
    const state = checkpoint();
    state.pending = Array.from({ length: 100 }, (_, i) => candidate(i + 1));
    const fetch = jest.fn().mockResolvedValue([]);
    await collectIntake(state, [], fetch, now);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('stops at repository creation and never moves the current cursor into the future', async () => {
    const fetch = jest.fn().mockResolvedValue([]);
    const state = checkpoint();
    state.historyFloor = '2026-10-30T00:00:00Z';
    const result = await collectIntake(state, [], fetch, '2026-11-02T00:00:00Z');
    expect(result.since).toBe('2026-11-02T00:00:00.000Z');
    expect(result.historyBefore).toBe('2026-10-30T00:00:00.000Z');
  });

  it('rejects invalid cache state, mismatched repositories and missing receipt evidence', async () => {
    expect(() => validateState(checkpoint(), 'other/repo')).toThrow('repository mismatch');
    expect(() => validateState({ ...checkpoint(), since: '2026-02-30T00:00:00Z' }, repository))
      .toThrow('timestamp');
    await expect(collectIntake(checkpoint(), [{
      number: 1, updatedAt: now, disposition: 'no-impact', evidence: '',
    }], async () => [], now)).rejects.toThrow('specific review evidence');
  });

  it('paginates all merges, not a keyword sample', async () => {
    const items = Array.from({ length: 100 }, (_, i) => candidate(i + 1));
    exec.mockReturnValueOnce(JSON.stringify({ total_count: 101, incomplete_results: false, items }))
      .mockReturnValueOnce(JSON.stringify({ total_count: 101, incomplete_results: false, items: [candidate(101)] }));
    expect(await fetchMergedWindow(repository, checkpoint().since, now)).toHaveLength(101);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls[0][1]).toContain(`q=repo:${repository} is:pr is:merged merged:${checkpoint().since}..${now}`);
    expect(exec.mock.calls[1][1]).toContain('page=2');
  });

  it('projects only compact public metadata, never API issue bodies or author objects', async () => {
    exec.mockReturnValueOnce(JSON.stringify({
      total_count: 1, incomplete_results: false,
      items: [{ ...candidate(1), body: 'UNTRUSTED_BODY', user: { login: 'author' } }],
    }));
    expect(await fetchMergedWindow(repository, checkpoint().since, now)).toEqual([candidate(1)]);
  });

  it.each([
    { total_count: 1001, incomplete_results: false, items: [] },
    { total_count: 1, incomplete_results: true, items: [candidate(1)] },
  ])('rejects truncated search results %j', async (response) => {
    exec.mockReturnValueOnce(JSON.stringify(response));
    await expect(fetchMergedWindow(repository, checkpoint().since, now)).rejects.toThrow('checkpoint not advanced');
  });

  it('rejects pagination duplicates and API errors', async () => {
    exec.mockReturnValueOnce(JSON.stringify({
      total_count: 2, incomplete_results: false, items: [candidate(1), candidate(1)],
    }));
    await expect(fetchMergedWindow(repository, checkpoint().since, now)).rejects.toThrow('pagination changed');
    exec.mockImplementationOnce(() => { throw new Error('rate limited'); });
    await expect(fetchMergedWindow(repository, checkpoint().since, now)).rejects.toThrow('rate limited');
  });

  it('rejects unsafe or malformed cached files without echoing their contents', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnosis-intake-'));
    try {
      const file = path.join(directory, 'state.json');
      fs.writeFileSync(file, JSON.stringify(checkpoint()));
      expect(readIntakeJson(file)).toEqual(checkpoint());
      const symlink = path.join(directory, 'symlink.json');
      fs.symlinkSync(file, symlink);
      expect(() => readIntakeJson(symlink)).toThrow();
      const hardlink = path.join(directory, 'hardlink.json');
      fs.linkSync(file, hardlink);
      expect(() => readIntakeJson(file)).toThrow('single-link regular JSON');
      fs.unlinkSync(hardlink);
      fs.writeFileSync(file, 'PRIVATE_MALFORMED_SENTINEL');
      expect(() => readIntakeJson(file)).toThrow('unreadable or malformed');
      try {
        readIntakeJson(file);
      } catch (error) {
        expect(String(error)).not.toContain('PRIVATE_MALFORMED_SENTINEL');
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
