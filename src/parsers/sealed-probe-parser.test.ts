import { normalizeSealedProbesConfig } from './sealed-probe-parser';
import { SEALED_PROBE_DEFAULTS } from '../types/sealed-probe-options';

describe('normalizeSealedProbesConfig', () => {
  it('returns undefined when raw is undefined (no sealedProbes section)', () => {
    expect(normalizeSealedProbesConfig(undefined)).toBeUndefined();
  });

  it('applies all centralized defaults when given an empty section', () => {
    expect(normalizeSealedProbesConfig({})).toEqual({
      enabled: false,
      privateRepos: [],
      runtime: SEALED_PROBE_DEFAULTS.runtime,
      timeout: SEALED_PROBE_DEFAULTS.timeout,
      memoryLimit: SEALED_PROBE_DEFAULTS.memoryLimit,
      interpreter: SEALED_PROBE_DEFAULTS.interpreter,
      maxInvocations: SEALED_PROBE_DEFAULTS.maxInvocations,
    });
  });

  it('normalizes enabled to false unless explicitly true', () => {
    expect(normalizeSealedProbesConfig({ enabled: false })?.enabled).toBe(false);
    // Only exact `true` enables; anything else normalizes away.
    expect(normalizeSealedProbesConfig({})?.enabled).toBe(false);
  });

  it('preserves an explicit enabled: true', () => {
    expect(
      normalizeSealedProbesConfig({ enabled: true, privateRepos: [{ repo: 'octo/repo', sensitivity: 'internal' }] })
        ?.enabled,
    ).toBe(true);
  });

  it('defaults privateRepos to an empty array when omitted', () => {
    expect(normalizeSealedProbesConfig({})?.privateRepos).toEqual([]);
  });

  it('passes through object-form privateRepos entries unchanged, in order, without deduplicating', () => {
    const warn = jest.fn();
    const config = normalizeSealedProbesConfig(
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
    // Duplicate rejection is `src/sealed-probe/preflight.ts`'s job, not the
    // normalizer's — the normalizer only fills defaults and migrates legacy
    // strings, so it must not silently drop or warn about anything here.
    expect(warn).not.toHaveBeenCalled();
  });

  it('normalizes a legacy bare-string entry to {repo, sensitivity: "internal"} and warns once', () => {
    const warn = jest.fn();
    const config = normalizeSealedProbesConfig({ privateRepos: ['octo/legacy'] }, { warn });

    expect(config?.privateRepos).toEqual([{ repo: 'octo/legacy', sensitivity: 'internal' }]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('octo/legacy');
    expect(warn.mock.calls[0][0]).toContain('legacy bare string');
  });

  it('warns once per legacy string entry, independently, in a mixed list', () => {
    const warn = jest.fn();
    const config = normalizeSealedProbesConfig(
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
    expect(() => normalizeSealedProbesConfig({ privateRepos: ['octo/legacy'] })).not.toThrow();
  });

  it('preserves explicitly-set fields over defaults', () => {
    const config = normalizeSealedProbesConfig({
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
    const config = normalizeSealedProbesConfig({ runtime: 'gvisor' });
    expect(config?.runtime).toBe('gvisor');
    expect(config?.timeout).toBe(SEALED_PROBE_DEFAULTS.timeout);
    expect(config?.memoryLimit).toBe(SEALED_PROBE_DEFAULTS.memoryLimit);
    expect(config?.interpreter).toBe(SEALED_PROBE_DEFAULTS.interpreter);
    expect(config?.maxInvocations).toBe(SEALED_PROBE_DEFAULTS.maxInvocations);
  });
});
