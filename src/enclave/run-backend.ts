import type { EnclaveRuntime, EnclavesConfig } from '../types/enclave-options';

type RunSandboxBackend = EnclaveRuntime | 'nvx';

/** Default Docker execution is represented by an absent primary runtime. */
export function resolveRunSandboxBackend(primaryRuntime?: string): RunSandboxBackend {
  if (primaryRuntime === undefined || primaryRuntime === 'docker' || primaryRuntime === 'runc') {
    return 'docker';
  }
  if (primaryRuntime === 'runsc') return 'gvisor';
  if (primaryRuntime === 'gvisor' || primaryRuntime === 'sbx'
    || primaryRuntime === 'cloud-hypervisor' || primaryRuntime === 'nvx') {
    return primaryRuntime;
  }
  throw new Error(`Enclaves require a known primary sandbox backend; received "${primaryRuntime}"`);
}

export function validateRunSandboxBackend(
  primaryRuntime: string | undefined,
  enclaves: EnclavesConfig,
): string[] {
  if (!enclaves.enabled) return [];
  let backend: RunSandboxBackend;
  try {
    backend = resolveRunSandboxBackend(primaryRuntime);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  return Object.entries(enclaves.executors)
    .filter(([, executor]) => executor.enabled && executor.runtime !== backend)
    .map(([kind, executor]) =>
      `Enclave ${kind} backend "${executor.runtime}" differs from primary backend "${backend}"; `
      + 'one sandbox backend is required per run; no runtime fallback');
}
