import { validateAwfFileConfig } from './config-file';

describe('validateAwfFileConfig — boundedQueries', () => {
  it('accepts an empty boundedQueries section', () => {
    expect(validateAwfFileConfig({ boundedQueries: {} })).toEqual([]);
  });

  it('accepts a fully-specified valid boundedQueries section using object-form privateRepos', () => {
    const errors = validateAwfFileConfig({
      boundedQueries: {
        enabled: true,
        privateRepos: [
          { repo: 'octo-org/octo-repo', sensitivity: 'internal' },
          { repo: 'octo-org/other.repo', sensitivity: 'confidential' },
        ],
        runtime: 'gvisor',
        timeout: 60,
        memoryLimit: '1g',
        interpreter: 'python3',
        maxInvocations: 10,
      },
    });

    expect(errors).toEqual([]);
  });

  it('accepts a legacy bare-string privateRepos entry (one-release compatibility)', () => {
    expect(validateAwfFileConfig({ boundedQueries: { privateRepos: ['octo-org/octo-repo'] } })).toEqual([]);
  });

  it('accepts a mix of legacy string and object-form privateRepos entries', () => {
    const errors = validateAwfFileConfig({
      boundedQueries: {
        privateRepos: ['octo/legacy', { repo: 'octo/object-form', sensitivity: 'sealed' }],
      },
    });
    expect(errors).toEqual([]);
  });

  it('rejects an object-form privateRepos entry with an invalid sensitivity value', () => {
    const errors = validateAwfFileConfig({
      boundedQueries: { privateRepos: [{ repo: 'octo/repo', sensitivity: 'top-secret' }] },
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects an object-form privateRepos entry missing sensitivity', () => {
    const errors = validateAwfFileConfig({
      boundedQueries: { privateRepos: [{ repo: 'octo/repo' }] },
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects an object-form privateRepos entry with unsupported extra properties', () => {
    const errors = validateAwfFileConfig({
      boundedQueries: { privateRepos: [{ repo: 'octo/repo', sensitivity: 'internal', extra: true }] },
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts privateRepos without enabled (not required unless enabled)', () => {
    expect(validateAwfFileConfig({ boundedQueries: { privateRepos: ['octo/repo'] } })).toEqual([]);
  });

  it('requires non-empty privateRepos when enabled is true', () => {
    expect(validateAwfFileConfig({ boundedQueries: { enabled: true } }).length).toBeGreaterThan(0);
    expect(validateAwfFileConfig({ boundedQueries: { enabled: true, privateRepos: [] } }).length).toBeGreaterThan(0);
  });

  // Duplicate-entry rejection depends on comparing normalized repo keys
  // across entries (which may mix legacy strings and objects), so it lives
  // in `src/bounded-query/preflight.ts` (see preflight.test.ts) rather than
  // in the raw JSON Schema, which validates one array item at a time.

  it.each([
    ['a URL', 'https://github.com/octo/repo'],
    ['a scheme-relative URL', '//github.com/octo/repo'],
    ['a wildcard', 'octo/*'],
    ['dot-traversal', 'octo/..'],
    ['a query string', 'octo/repo?x=1'],
    ['a fragment', 'octo/repo#section'],
    ['an extra path segment', 'octo/repo/extra'],
    ['no owner', '/repo'],
    ['no slash at all', 'octorepo'],
  ])('rejects a privateRepos entry that is %s', (_label, entry) => {
    const errors = validateAwfFileConfig({ boundedQueries: { privateRepos: [entry] } });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts owner/repo slugs with dots, dashes, and underscores in the repo segment', () => {
    const errors = validateAwfFileConfig({
      boundedQueries: { privateRepos: ['my-org-1/my.repo-name_2'] },
    });
    expect(errors).toEqual([]);
  });

  it('rejects an invalid runtime value', () => {
    const errors = validateAwfFileConfig({ boundedQueries: { runtime: 'vmware' } });
    expect(errors.length).toBeGreaterThan(0);
  });

  it.each(['docker', 'gvisor'])('accepts runtime %s', (runtime) => {
    expect(validateAwfFileConfig({ boundedQueries: { runtime } })).toEqual([]);
  });

  it('rejects a non-positive or out-of-bounds timeout', () => {
    expect(validateAwfFileConfig({ boundedQueries: { timeout: 0 } }).length).toBeGreaterThan(0);
    expect(validateAwfFileConfig({ boundedQueries: { timeout: -5 } }).length).toBeGreaterThan(0);
    expect(validateAwfFileConfig({ boundedQueries: { timeout: 1.5 } }).length).toBeGreaterThan(0);
    expect(validateAwfFileConfig({ boundedQueries: { timeout: 999999 } }).length).toBeGreaterThan(0);
  });

  it('accepts a timeout within bounds', () => {
    expect(validateAwfFileConfig({ boundedQueries: { timeout: 30 } })).toEqual([]);
  });

  it('accepts the maximum timeout of 540 seconds and rejects one second above it', () => {
    expect(validateAwfFileConfig({ boundedQueries: { timeout: 540 } })).toEqual([]);
    expect(validateAwfFileConfig({ boundedQueries: { timeout: 541 } }).length).toBeGreaterThan(0);
  });

  it('rejects an invalid memoryLimit format', () => {
    expect(validateAwfFileConfig({ boundedQueries: { memoryLimit: '512' } }).length).toBeGreaterThan(0);
    expect(validateAwfFileConfig({ boundedQueries: { memoryLimit: '0m' } }).length).toBeGreaterThan(0);
    expect(validateAwfFileConfig({ boundedQueries: { memoryLimit: '1gb' } }).length).toBeGreaterThan(0);
  });

  it.each(['512m', '1g', '2G', '256M'])('accepts memoryLimit %s', (memoryLimit) => {
    expect(validateAwfFileConfig({ boundedQueries: { memoryLimit } })).toEqual([]);
  });

  it('rejects an interpreter other than python3', () => {
    expect(validateAwfFileConfig({ boundedQueries: { interpreter: 'node' } }).length).toBeGreaterThan(0);
  });

  it('rejects a non-positive or out-of-bounds maxInvocations', () => {
    expect(validateAwfFileConfig({ boundedQueries: { maxInvocations: 0 } }).length).toBeGreaterThan(0);
    expect(validateAwfFileConfig({ boundedQueries: { maxInvocations: -1 } }).length).toBeGreaterThan(0);
    expect(validateAwfFileConfig({ boundedQueries: { maxInvocations: 100000 } }).length).toBeGreaterThan(0);
  });

  it('rejects unknown properties inside boundedQueries', () => {
    const errors = validateAwfFileConfig({ boundedQueries: { foo: 'bar' } });
    expect(errors).toContain('config.boundedQueries.foo is not supported');
  });
});
