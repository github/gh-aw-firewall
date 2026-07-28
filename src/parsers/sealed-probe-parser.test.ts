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
    expect(normalizeSealedProbesConfig({ enabled: true, privateRepos: ['octo/repo'] })?.enabled).toBe(true);
  });

  it('deduplicates privateRepos', () => {
    const config = normalizeSealedProbesConfig({ privateRepos: ['octo/repo', 'octo/repo', 'octo/other'] });
    expect(config?.privateRepos).toEqual(['octo/repo', 'octo/other']);
  });

  it('defaults privateRepos to an empty array when omitted', () => {
    expect(normalizeSealedProbesConfig({})?.privateRepos).toEqual([]);
  });

  it('preserves explicitly-set fields over defaults', () => {
    const config = normalizeSealedProbesConfig({
      enabled: true,
      privateRepos: ['octo/repo'],
      runtime: 'sbx',
      timeout: 120,
      memoryLimit: '2g',
      interpreter: 'python3',
      maxInvocations: 5,
    });

    expect(config).toEqual({
      enabled: true,
      privateRepos: ['octo/repo'],
      runtime: 'sbx',
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
