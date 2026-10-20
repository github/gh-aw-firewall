import { normalizeEnclavesConfig } from '../parsers/enclave-parser';
import { resolveRunSandboxBackend, validateRunSandboxBackend } from './run-backend';

describe('run sandbox backend', () => {
  it.each([
    ['primary-only', []],
    ['script-only', [{ script: {} }]],
    ['agent-only', [{ agent: { model: 'trusted-model' } }]],
    ['primary-plus-both', [{ script: {} }, { agent: { model: 'trusted-model' } }]],
  ])('keeps backend selection separate from launch admission for %s', (_name, entries) => {
    for (const runtime of ['docker', 'cloud-hypervisor'] as const) {
      const enclaves = normalizeEnclavesConfig(entries.map(entry => ({
        ...entry,
        runtime,
        repos: [{ repo: 'octo/private', sensitivity: 'internal' as const }],
      })))!;
      const snapshot = structuredClone(enclaves);
      expect(validateRunSandboxBackend(runtime, enclaves)).toEqual([]);
      expect(enclaves).toEqual(snapshot);
      if (enclaves.enabled) {
        expect(validateRunSandboxBackend('nvx', enclaves)).toEqual(
          Object.values(enclaves.executors)
            .filter(executor => executor.enabled)
            .map(() => expect.stringContaining('one sandbox backend is required per run; no runtime fallback')),
        );
        expect(enclaves).toEqual(snapshot);
      }
    }
  });

  it.each([
    [undefined, 'docker'], ['docker', 'docker'], ['runc', 'docker'],
    ['runsc', 'gvisor'], ['gvisor', 'gvisor'], ['sbx', 'sbx'],
    ['cloud-hypervisor', 'cloud-hypervisor'], ['nvx', 'nvx'],
  ])('resolves %s to %s', (runtime, expected) => {
    expect(resolveRunSandboxBackend(runtime)).toBe(expected);
  });

  it('does not equate Docker orchestration with gVisor isolation', () => {
    const enclaves = normalizeEnclavesConfig([{ script: {}, repos: [] }])!;
    expect(validateRunSandboxBackend('gvisor', enclaves)).toEqual([
      expect.stringContaining('differs from primary backend "gvisor"'),
    ]);
    expect(validateRunSandboxBackend(undefined, enclaves)).toEqual([]);
  });

  it('validates all enabled executors in an already assembled configuration', () => {
    const enclaves = normalizeEnclavesConfig([
      { script: {}, runtime: 'gvisor', repos: [] },
      { agent: { model: 'model' }, runtime: 'cloud-hypervisor', repos: [] },
    ])!;
    expect(validateRunSandboxBackend(undefined, enclaves)).toHaveLength(2);
    expect(validateRunSandboxBackend('cloud-hypervisor', enclaves)).toHaveLength(1);
  });

  it('ignores disabled executors and rejects unknown enclave run backends', () => {
    const enclaves = normalizeEnclavesConfig([{ script: {}, runtime: 'gvisor', repos: [] }])!;
    expect(validateRunSandboxBackend('runsc', enclaves)).toEqual([]);
    expect(validateRunSandboxBackend('custom', enclaves)).toEqual([
      expect.stringContaining('known primary sandbox backend'),
    ]);
    expect(validateRunSandboxBackend('custom', normalizeEnclavesConfig([])!)).toEqual([]);
  });
});
