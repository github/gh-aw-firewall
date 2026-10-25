import * as journal from './host-executor-journal';
import * as diagnostics from './host-executor-diagnostics';
import * as resources from './host-executor-resource-journal';
import type { HostExecutorControlPhase } from './host-executor-journal';

describe('host executor journal compatibility exports', () => {
  function expectCompatibility(
    legacy: typeof journal,
    focusedDiagnostics: typeof diagnostics,
    focusedResources: typeof resources,
  ): void {
    expect(legacy.HostExecutorControlDiagnostics).toBe(focusedDiagnostics.HostExecutorControlDiagnostics);
    expect(legacy.HostExecutorInvocationDiagnostics).toBe(focusedDiagnostics.HostExecutorInvocationDiagnostics);
    expect(legacy.persistHostExecutorProxyUsage).toBe(focusedDiagnostics.persistHostExecutorProxyUsage);
    expect(legacy.persistHostExecutorProxyResponseDiagnostics).toBe(focusedDiagnostics.persistHostExecutorProxyResponseDiagnostics);
    expect(legacy.persistHostExecutorProxyDebugDiagnostics).toBe(focusedDiagnostics.persistHostExecutorProxyDebugDiagnostics);
    expect(legacy.readHostExecutorInvocationDiagnostics).toBe(focusedDiagnostics.readHostExecutorInvocationDiagnostics);
    expect(legacy.HostExecutorResourceJournal).toBe(focusedResources.HostExecutorResourceJournal);
    expect(legacy.reapHostExecutorResources).toBe(focusedResources.reapHostExecutorResources);
    expect([
      legacy.HostExecutorControlDiagnostics,
      legacy.HostExecutorInvocationDiagnostics,
      legacy.persistHostExecutorProxyUsage,
      legacy.persistHostExecutorProxyResponseDiagnostics,
      legacy.persistHostExecutorProxyDebugDiagnostics,
      legacy.readHostExecutorInvocationDiagnostics,
      legacy.HostExecutorResourceJournal,
      legacy.reapHostExecutorResources,
    ]).toEqual(Array(8).fill(expect.any(Function)));
    expect(legacy.hostExecutorStorageDirectory('a'.repeat(32)))
      .toBe(`${legacy.HOST_EXECUTOR_STORAGE_ROOT}/${'a'.repeat(32)}`);
  }

  it('reexports every moved public value with its focused module identity', () => {
    expectCompatibility(journal, diagnostics, resources);
    const phase: HostExecutorControlPhase = 'shutdown';
    expect(phase).toBe('shutdown');
  });

  it.each([
    ['shared-primitives-first', () => jest.requireActual('./host-executor-journal-shared')],
    ['legacy-first', () => jest.requireActual('./host-executor-journal')],
    ['diagnostics-first', () => jest.requireActual('./host-executor-diagnostics')],
    ['resource-journal-first', () => jest.requireActual('./host-executor-resource-journal')],
    ['storage-records-first', () => jest.requireActual('./host-executor-storage-records')],
  ] as const)('preserves initialized exports when loaded %s', (_name, loadFirst) => {
    jest.isolateModules(() => {
      loadFirst();
      expectCompatibility(
        jest.requireActual<typeof journal>('./host-executor-journal'),
        jest.requireActual<typeof diagnostics>('./host-executor-diagnostics'),
        jest.requireActual<typeof resources>('./host-executor-resource-journal'),
      );
    });
  });
});
