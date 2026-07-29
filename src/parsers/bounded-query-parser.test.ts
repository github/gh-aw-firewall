import { normalizeBoundedQueriesConfig } from './bounded-query-parser';
import { BOUNDED_QUERY_DEFAULTS } from '../types/bounded-query-options';

describe('normalizeBoundedQueriesConfig', () => {
  it('returns undefined when raw is undefined (no boundedQueries section)', () => {
    expect(normalizeBoundedQueriesConfig(undefined)).toBeUndefined();
  });

  it('applies all centralized defaults when given an empty section', () => {
    expect(normalizeBoundedQueriesConfig({})).toEqual({
      enabled: false,
      privateRepos: [],
      runtime: BOUNDED_QUERY_DEFAULTS.runtime,
      timeout: BOUNDED_QUERY_DEFAULTS.timeout,
      memoryLimit: BOUNDED_QUERY_DEFAULTS.memoryLimit,
      interpreter: BOUNDED_QUERY_DEFAULTS.interpreter,
      maxInvocations: BOUNDED_QUERY_DEFAULTS.maxInvocations,
    });
  });

  it('normalizes enabled to false unless explicitly true', () => {
    expect(normalizeBoundedQueriesConfig({ enabled: false })?.enabled).toBe(false);
    // Only exact `true` enables; anything else normalizes away.
    expect(normalizeBoundedQueriesConfig({})?.enabled).toBe(false);
  });

  it('preserves an explicit enabled: true', () => {
    expect(
      normalizeBoundedQueriesConfig({ enabled: true, privateRepos: [{ repo: 'octo/repo', sensitivity: 'internal' }] })
        ?.enabled,
    ).toBe(true);
  });

  it('defaults privateRepos to an empty array when omitted', () => {
    expect(normalizeBoundedQueriesConfig({})?.privateRepos).toEqual([]);
  });

  it('passes through object-form privateRepos entries unchanged, in order, without deduplicating', () => {
    const warn = jest.fn();
    const config = normalizeBoundedQueriesConfig(
      {
        privateRepos: [
          { repo: 'octo/repo', sensitivity: 'internal' },
          { repo: 'octo/repo', sensitivity: 'internal' },
          { repo: 'octo/other', sensitivity: 'confidential' },
        ],
      },
      { warn },
    );
    expect(config?.privateRepos).toEqual([
      { repo: 'octo/repo', sensitivity: 'internal' },
      { repo: 'octo/repo', sensitivity: 'internal' },
      { repo: 'octo/other', sensitivity: 'confidential' },
    ]);
    // Duplicate rejection is `src/bounded-query/preflight.ts`'s job, not the
    // normalizer's — the normalizer only fills defaults and migrates legacy
    // strings, so it must not silently drop or warn about anything here.
    expect(warn).not.toHaveBeenCalled();
  });

  it('normalizes a legacy bare-string entry to {repo, sensitivity: "internal"} and warns once', () => {
    const warn = jest.fn();
    const config = normalizeBoundedQueriesConfig({ privateRepos: ['octo/legacy'] }, { warn });

    expect(config?.privateRepos).toEqual([{ repo: 'octo/legacy', sensitivity: 'internal' }]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('octo/legacy');
    expect(warn.mock.calls[0][0]).toContain('legacy bare string');
  });

  it('warns once per legacy string entry, independently, in a mixed list', () => {
    const warn = jest.fn();
    const config = normalizeBoundedQueriesConfig(
      {
        privateRepos: ['octo/legacy-one', { repo: 'octo/object-form', sensitivity: 'sealed' }, 'octo/legacy-two'],
      },
      { warn },
    );

    expect(config?.privateRepos).toEqual([
      { repo: 'octo/legacy-one', sensitivity: 'internal' },
      { repo: 'octo/object-form', sensitivity: 'sealed' },
      { repo: 'octo/legacy-two', sensitivity: 'internal' },
    ]);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('defaults to logger.warn when no warn override is supplied (does not throw)', () => {
    expect(() => normalizeBoundedQueriesConfig({ privateRepos: ['octo/legacy'] })).not.toThrow();
  });

  it('preserves explicitly-set fields over defaults', () => {
    const config = normalizeBoundedQueriesConfig({
      enabled: true,
      privateRepos: [{ repo: 'octo/repo', sensitivity: 'confidential' }],
      runtime: 'gvisor',
      timeout: 120,
      memoryLimit: '2g',
      interpreter: 'python3',
      maxInvocations: 5,
    });

    expect(config).toEqual({
      enabled: true,
      privateRepos: [{ repo: 'octo/repo', sensitivity: 'confidential' }],
      runtime: 'gvisor',
      timeout: 120,
      memoryLimit: '2g',
      interpreter: 'python3',
      maxInvocations: 5,
    });
  });

  it('applies defaults field-by-field (partial overrides)', () => {
    const config = normalizeBoundedQueriesConfig({ runtime: 'gvisor' });
    expect(config?.runtime).toBe('gvisor');
    expect(config?.timeout).toBe(BOUNDED_QUERY_DEFAULTS.timeout);
    expect(config?.memoryLimit).toBe(BOUNDED_QUERY_DEFAULTS.memoryLimit);
    expect(config?.interpreter).toBe(BOUNDED_QUERY_DEFAULTS.interpreter);
    expect(config?.maxInvocations).toBe(BOUNDED_QUERY_DEFAULTS.maxInvocations);
  });
});
