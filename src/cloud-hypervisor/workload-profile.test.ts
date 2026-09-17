import {
  assertCloudHypervisorWorkloadLaunchable,
  createAgentEnclaveCloudHypervisorProfile,
  createPrimaryAgentCloudHypervisorProfile,
  createScriptEnclaveCloudHypervisorProfile,
  validateCloudHypervisorWorkloadProfile,
} from './workload-profile';

const supervisor = {
  exports: [{ tag: 'seed', source: '/seed', target: '/seed', mode: 'ro' as const }],
  supervisorBinaryPath: '/opt/awf-supervisor',
  supervisorSha256: 'a'.repeat(64),
  workspaceMount: null as null,
};

describe('Cloud Hypervisor workload profiles', () => {
  it.each([
    [
      'primary-agent',
      () => createPrimaryAgentCloudHypervisorProfile({
        network: {
          infrastructureBridge: 'awfbr0',
          enableApiProxy: true,
          apiProxyIp: '172.30.0.30',
        },
        guest: {
          ...supervisor,
          exports: [{
            tag: 'workspace',
            source: '/workspace',
            target: '/workspace',
            mode: 'rw',
          }],
          workspaceMount: '/workspace',
        },
      }),
      'capture',
      'primary',
    ],
    [
      'script-enclave',
      () => createScriptEnclaveCloudHypervisorProfile({
        enclaveId: 'script-entry',
        invocationId: 'invocation-1',
        guest: supervisor,
      }),
      'discard',
      'none',
    ],
    [
      'agent-enclave',
      () => createAgentEnclaveCloudHypervisorProfile({
        enclaveId: 'agent-entry',
        invocationId: 'invocation-2',
        guest: supervisor,
        apiProxy: { ip: '172.31.0.30', port: 10002 },
        githubDataPlane: { ip: '172.31.0.40', port: 8080 },
      }),
      'discard',
      'enclave-agent',
    ],
  ])('creates the closed %s profile', (kind, create, rawOutput, networkMode) => {
    expect(create()).toMatchObject({
      kind,
      identity: { kind },
      rootfsRole: kind,
      rawOutput,
      network: { mode: networkMode },
    });
  });

  it.each([
    [
      'mismatched identity',
      (profile: Record<string, any>) => { profile.identity.kind = 'script-enclave'; },
      /identity and rootfs role/,
    ],
    [
      'primary profile without its workspace',
      (profile: Record<string, any>) => { profile.guest.workspaceMount = null; },
      /workspace mount/,
    ],
    [
      'primary profile with an invalid API proxy address',
      (profile: Record<string, any>) => { profile.network.apiProxyIp = 'api-proxy'; },
      /must be an IPv4 address/,
    ],
    [
      'enclave profile retaining raw output',
      (profile: Record<string, any>) => {
        profile.kind = 'script-enclave';
        profile.identity = {
          kind: 'script-enclave',
          ownerId: 'script-entry',
          invocationId: 'invocation',
        };
        profile.rootfsRole = 'script-enclave';
        profile.network = { mode: 'none' };
        profile.guest.workspaceMount = null;
      },
      /script-enclave workload profile/,
    ],
    [
      'an unknown launch control',
      (profile: Record<string, any>) => { profile.command = ['/bin/sh']; },
      /Unknown Cloud Hypervisor workload profile field/,
    ],
  ])('rejects %s', (_name, mutate, expected) => {
    const profile = structuredClone(createPrimaryAgentCloudHypervisorProfile({
      network: {
        infrastructureBridge: 'awfbr0',
        enableApiProxy: true,
        apiProxyIp: '172.30.0.30',
      },
      guest: {
        ...supervisor,
        exports: [{
          tag: 'workspace',
          source: '/workspace',
          target: '/workspace',
          mode: 'rw',
        }],
        workspaceMount: '/workspace',
      },
    })) as unknown as Record<string, any>;
    mutate(profile);
    expect(() => validateCloudHypervisorWorkloadProfile(profile as never)).toThrow(expected);
  });

  it.each([
    { tag: 'workspace', source: '/seed', target: '/seed', mode: 'ro' as const },
    { tag: 'seed', source: '/workspace', target: '/workspace', mode: 'ro' as const },
    { tag: 'seed', source: '/workspace', target: '/workspace/private', mode: 'ro' as const },
  ])('rejects workspace export (tag=$tag, target=$target)', (workspaceExport) => {
    const profile = {
      ...createScriptEnclaveCloudHypervisorProfile({
        enclaveId: 'script-entry',
        invocationId: 'invocation',
        guest: supervisor,
      }),
      guest: { ...supervisor, exports: [workspaceExport] },
    };

    expect(() => validateCloudHypervisorWorkloadProfile(profile))
      .toThrow(/must not declare a primary workspace mount/);
  });

  it.each([
    createScriptEnclaveCloudHypervisorProfile({
      enclaveId: 'script-entry',
      invocationId: 'invocation-1',
      guest: supervisor,
    }),
    createAgentEnclaveCloudHypervisorProfile({
      enclaveId: 'agent-entry',
      invocationId: 'invocation-2',
      guest: supervisor,
      apiProxy: { ip: '172.31.0.30', port: 10002 },
    }),
  ])('fails closed before an enclave profile can launch', (profile) => {
    expect(() => assertCloudHypervisorWorkloadLaunchable(profile)).toThrow(
      /not implemented; refusing to fall back/,
    );
  });

  it('snapshots and freezes trusted profile input', () => {
    const hostAliases = { gateway: '172.30.0.60' };
    const profile = createPrimaryAgentCloudHypervisorProfile({
      network: {
        infrastructureBridge: 'awfbr0',
        enableApiProxy: false,
        hostAliases,
      },
    });

    hostAliases.gateway = '127.0.0.1';
    expect(profile.network.hostAliases).toEqual({ gateway: '172.30.0.60' });
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.network.hostAliases)).toBe(true);
  });
});
