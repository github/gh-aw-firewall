import { validateAwfFileConfig } from './config-file';

describe('validateAwfFileConfig — sealedProbes', () => {
  it('accepts an empty sealedProbes section', () => {
    expect(validateAwfFileConfig({ sealedProbes: {} })).toEqual([]);
  });

  it('accepts a fully-specified valid sealedProbes section using object-form privateRepos', () => {
    const errors = validateAwfFileConfig({
      sealedProbes: {
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
    expect(validateAwfFileConfig({ sealedProbes: { privateRepos: ['octo-org/octo-repo'] } })).toEqual([]);
  });

  it('accepts a mix of legacy string and object-form privateRepos entries', () => {
    const errors = validateAwfFileConfig({
      sealedProbes: {
        privateRepos: ['octo/legacy', { repo: 'octo/object-form', sensitivity: 'sealed' }],
      },
    });
    expect(errors).toEqual([]);
  });

  it('rejects an object-form privateRepos entry with an invalid sensitivity value', () => {
    const errors = validateAwfFileConfig({
      sealedProbes: { privateRepos: [{ repo: 'octo/repo', sensitivity: 'top-secret' }] },
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects an object-form privateRepos entry missing sensitivity', () => {
    const errors = validateAwfFileConfig({
      sealedProbes: { privateRepos: [{ repo: 'octo/repo' }] },
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects an object-form privateRepos entry with unsupported extra properties', () => {
    const errors = validateAwfFileConfig({
      sealedProbes: { privateRepos: [{ repo: 'octo/repo', sensitivity: 'internal', extra: true }] },
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts privateRepos without enabled (not required unless enabled)', () => {
    expect(validateAwfFileConfig({ sealedProbes: { privateRepos: ['octo/repo'] } })).toEqual([]);
  });

  it('requires non-empty privateRepos when enabled is true', () => {
    expect(validateAwfFileConfig({ sealedProbes: { enabled: true } }).length).toBeGreaterThan(0);
    expect(validateAwfFileConfig({ sealedProbes: { enabled: true, privateRepos: [] } }).length).toBeGreaterThan(0);
  });

  // Duplicate-entry rejection depends on comparing normalized repo keys
  // across entries (which may mix legacy strings and objects), so it lives
  // in `src/sealed-probe/preflight.ts` (see preflight.test.ts) rather than
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
    const errors = validateAwfFileConfig({ sealedProbes: { privateRepos: [entry] } });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts owner/repo slugs with dots, dashes, and underscores in the repo segment', () => {
    const errors = validateAwfFileConfig({
      sealedProbes: { privateRepos: ['my-org-1/my.repo-name_2'] },
    });
    expect(errors).toEqual([]);
  });

  it('rejects an invalid runtime value', () => {
    const errors = validateAwfFileConfig({ sealedProbes: { runtime: 'vmware' } });
    expect(errors.length).toBeGreaterThan(0);
  });

  it.each(['docker', 'gvisor'])('accepts runtime %s', (runtime) => {
    expect(validateAwfFileConfig({ sealedProbes: { runtime } })).toEqual([]);
  });

  it('rejects a non-positive or out-of-bounds timeout', () => {
    expect(validateAwfFileConfig({ sealedProbes: { timeout: 0 } }).length).toBeGreaterThan(0);
    expect(validateAwfFileConfig({ sealedProbes: { timeout: -5 } }).length).toBeGreaterThan(0);
    expect(validateAwfFileConfig({ sealedProbes: { timeout: 1.5 } }).length).toBeGreaterThan(0);
    expect(validateAwfFileConfig({ sealedProbes: { timeout: 999999 } }).length).toBeGreaterThan(0);
  });

  it('accepts a timeout within bounds', () => {
    expect(validateAwfFileConfig({ sealedProbes: { timeout: 30 } })).toEqual([]);
  });

  it('accepts the maximum timeout of 540 seconds and rejects one second above it', () => {
    expect(validateAwfFileConfig({ sealedProbes: { timeout: 540 } })).toEqual([]);
    expect(validateAwfFileConfig({ sealedProbes: { timeout: 541 } }).length).toBeGreaterThan(0);
  });

  it('rejects an invalid memoryLimit format', () => {
    expect(validateAwfFileConfig({ sealedProbes: { memoryLimit: '512' } }).length).toBeGreaterThan(0);
    expect(validateAwfFileConfig({ sealedProbes: { memoryLimit: '0m' } }).length).toBeGreaterThan(0);
    expect(validateAwfFileConfig({ sealedProbes: { memoryLimit: '1gb' } }).length).toBeGreaterThan(0);
  });

  it.each(['512m', '1g', '2G', '256M'])('accepts memoryLimit %s', (memoryLimit) => {
    expect(validateAwfFileConfig({ sealedProbes: { memoryLimit } })).toEqual([]);
  });

  it('rejects an interpreter other than python3', () => {
    expect(validateAwfFileConfig({ sealedProbes: { interpreter: 'node' } }).length).toBeGreaterThan(0);
  });

  it('rejects a non-positive or out-of-bounds maxInvocations', () => {
    expect(validateAwfFileConfig({ sealedProbes: { maxInvocations: 0 } }).length).toBeGreaterThan(0);
    expect(validateAwfFileConfig({ sealedProbes: { maxInvocations: -1 } }).length).toBeGreaterThan(0);
    expect(validateAwfFileConfig({ sealedProbes: { maxInvocations: 100000 } }).length).toBeGreaterThan(0);
  });

  it('rejects unknown properties inside sealedProbes', () => {
    const errors = validateAwfFileConfig({ sealedProbes: { foo: 'bar' } });
    expect(errors).toContain('config.sealedProbes.foo is not supported');
  });
});
