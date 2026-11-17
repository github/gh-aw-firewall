import { HostEnclavePublicArtifacts, hostEnclaveOperationStage } from './host-enclave-public-artifacts';
import { staticStagingScenarios, useBackendFixture } from './host-enclave-executor.test-utils';

describe('host enclave public artifacts', () => {
  const fixture = useBackendFixture(staticStagingScenarios[2]);

  it('records a policy failure without claiming a workload launched or exposing a policy', async () => {
    const { plan, backendOptions, dependencies, preservePublicArtifacts } = fixture();
    const artifacts = new HostEnclavePublicArtifacts({ ...backendOptions, plan });
    artifacts.operations!.fail('authority-handoff', new Error('private policy'), false, 'host-exception');

    await artifacts.preserveSetupFailure(dependencies);

    expect(preservePublicArtifacts).toHaveBeenCalledWith(expect.objectContaining({
      secrets: [],
      stdout: { status: 'unavailable' },
      stderr: { status: 'unavailable' },
      session: { status: 'unavailable' },
      envelope: expect.objectContaining({
        runId: plan.runId, invocationId: plan.invocationId, entryId: plan.entryId,
        runtime: 'cloud-hypervisor', stage: 'setup', failure: 'setup-failed',
        exitCode: null, workloadStopped: true, workloadLaunched: false,
      }),
    }));
    expect(JSON.stringify(preservePublicArtifacts.mock.calls)).not.toContain('private policy');
  });

  it('does not repersist cleanup evidence before an artifact has been collected', async () => {
    const { plan, backendOptions, dependencies, preservePublicArtifacts } = fixture();
    const artifacts = new HostEnclavePublicArtifacts({ ...backendOptions, plan });
    artifacts.operations!.fail('cleanup', new Error('fixture error'), true, 'retention-failed');
    await artifacts.preserveCleanupFailure(dependencies);
    expect(preservePublicArtifacts).not.toHaveBeenCalled();
    expect(new HostEnclavePublicArtifacts({ plan }).operations).toBeUndefined();
  });

  it.each([
    ['policy', 'authority-handoff'], ['input-staging', 'authority-handoff'], ['export-plan', 'authority-handoff'],
    ['snapshot', 'storage-probe'], ['snapshot-digest', 'storage-probe'], ['workload-profile', 'storage-probe'],
    ['manager-create', 'workload-create'], ['manager-start', 'workload-start'], ['instance-start', 'workload-start'],
    ['guest-execute', 'workload-exit'], ['result-read', 'output-validation'], ['filesystem', 'storage-preparation'],
  ])('maps %s to the existing public operation stage', (check, stage) => {
    expect(hostEnclaveOperationStage(check)).toBe(stage);
  });
});
