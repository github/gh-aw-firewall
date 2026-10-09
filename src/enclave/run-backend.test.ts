import { normalizeEnclavesConfig } from '../parsers/enclave-parser';
import { resolveRunSandboxBackend, validateRunSandboxBackend } from './run-backend';

describe('run sandbox backend', () => {
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
