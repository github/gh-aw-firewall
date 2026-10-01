import {
  assertCloudHypervisorWorkloadLaunchable,
  createAgentEnclaveCloudHypervisorProfile,
  createPrimaryAgentCloudHypervisorProfile,
  createScriptEnclaveCloudHypervisorProfile,
  validateCloudHypervisorWorkloadProfile,
} from './workload-profile';
import type {
  CloudHypervisorEnclaveExportPlan,
  CloudHypervisorEnclaveExportRole,
} from './enclave-export-plan';
import * as path from 'path';

const supervisor = {
  supervisorBinaryPath: '/opt/awf-supervisor',
  supervisorSha256: 'a'.repeat(64),
};

function exportPlan(
  role: CloudHypervisorEnclaveExportRole,
  entryId = role === 'script' ? 'script-entry' : 'agent-entry',
  invocationId = role === 'script' ? 'b'.repeat(32) : 'd'.repeat(32),
): CloudHypervisorEnclaveExportPlan {
  const seedsDir = '/trusted/seeds';
  const invocationsDir = '/trusted/invocations';
  const seedId = 'c'.repeat(32);
  const invocationHostDir = path.join(invocationsDir, entryId, invocationId);
  const exports: CloudHypervisorEnclaveExportPlan['exports'][number][] = [
    { tag: 'enclave-seed', source: path.join(seedsDir, seedId), target: '/input-seed', mode: 'ro' },
    { tag: 'enclave-request', source: path.join(invocationHostDir, 'request'), target: '/input-request', mode: 'ro' },
    { tag: 'enclave-output', source: path.join(invocationHostDir, 'output'), target: '/output', mode: 'rw' },
    { tag: 'enclave-runtime', source: path.join(invocationHostDir, 'runtime'), target: '/runtime', mode: 'rw' },
  ];
  if (role === 'agent') {
    exports.push(
      { tag: 'enclave-session-handoff', source: path.join(invocationHostDir, 'session-handoff'), target: '/session-handoff', mode: 'rw' },
      { tag: 'enclave-session-state', source: path.join(invocationHostDir, 'session-state'), target: '/session-state', mode: 'rw' },
    );
  }
  return {
    role,
    runId: 'a'.repeat(32),
    entryId,
    invocationId,
    seedId,
    seedsDir,
    invocationsDir,
    invocationHostDir,
    exports,
  };
}

function primaryProfile(): Record<string, any> {
  return structuredClone(createPrimaryAgentCloudHypervisorProfile({
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
}

function scriptProfile(): Record<string, any> {
  return structuredClone(createScriptEnclaveCloudHypervisorProfile({
    enclaveId: 'script-entry',
    invocationId: 'b'.repeat(32),
    guest: supervisor,
    exportPlan: exportPlan('script'),
  })) as unknown as Record<string, any>;
}

function agentProfile(): Record<string, any> {
  return structuredClone(createAgentEnclaveCloudHypervisorProfile({
    enclaveId: 'agent-entry',
    invocationId: 'd'.repeat(32),
    guest: supervisor,
    exportPlan: exportPlan('agent'),
    apiProxy: { ip: '172.31.0.30', engine: 'copilot', profile: 'anthropic' },
  })) as unknown as Record<string, any>;
}

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
        invocationId: 'b'.repeat(32),
        guest: supervisor,
        exportPlan: exportPlan('script'),
      }),
      'discard',
      'none',
    ],
    [
      'agent-enclave',
      () => createAgentEnclaveCloudHypervisorProfile({
        enclaveId: 'agent-entry',
        invocationId: 'd'.repeat(32),
        guest: supervisor,
        exportPlan: exportPlan('agent'),
        apiProxy: { ip: '172.31.0.30', engine: 'copilot', profile: 'anthropic' },
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
    const profile = primaryProfile();
    mutate(profile);
    expect(() => validateCloudHypervisorWorkloadProfile(profile as never)).toThrow(expected);
  });

  it.each([
    { tag: 'workspace', target: '/seed' },
    { tag: 'enclave-seed', target: '/workspace' },
    { tag: 'enclave-seed', target: '/workspace/private' },
  ])('rejects caller-selected workspace export (tag=$tag, target=$target)', (workspaceExport) => {
    const plan = exportPlan('script');
    const exports = plan.exports.map((entry, index) => (
      index === 0 ? { ...entry, ...workspaceExport } : entry
    ));
    expect(() => createScriptEnclaveCloudHypervisorProfile({
      enclaveId: 'script-entry',
      invocationId: plan.invocationId,
      guest: supervisor,
      exportPlan: { ...plan, exports },
    })).toThrow(/invalid "enclave-seed" export/);
  });

  it.each([
    ['script-enclave', scriptProfile, 'script'],
    ['agent-enclave', agentProfile, 'agent'],
  ] as const)('keeps the exact closed %s export set', (_kind, create, role) => {
    const expected = exportPlan(role).exports.map(({ tag, target, mode }) => ({ tag, target, mode }));
    expect(create().guest.exports.map(({ tag, target, mode }: {
      tag: string;
      target: string;
      mode: string;
    }) => ({ tag, target, mode }))).toEqual(expected);
  });

  it.each([
    [
      'a contradictory primary output policy',
      primaryProfile,
      (profile: Record<string, any>) => { profile.rawOutput = 'discard'; },
      /Contradictory Cloud Hypervisor primary-agent/,
    ],
    [
      'a contradictory agent output policy',
      agentProfile,
      (profile: Record<string, any>) => { profile.rawOutput = 'capture'; },
      /Contradictory Cloud Hypervisor agent-enclave/,
    ],
    [
      'an unknown profile kind',
      primaryProfile,
      (profile: Record<string, any>) => {
        profile.kind = 'unknown';
        profile.identity.kind = 'unknown';
        profile.rootfsRole = 'unknown';
      },
      /Unsupported Cloud Hypervisor workload profile/,
    ],
    [
      'a missing enclave guest',
      scriptProfile,
      (profile: Record<string, any>) => { delete profile.guest; },
      /guest configuration is required/,
    ],
    [
      'an incomplete supervisor',
      scriptProfile,
      (profile: Record<string, any>) => { profile.guest.supervisorBinaryPath = 'relative'; },
      /supervisor configuration is incomplete/,
    ],
    [
      'an enclave primary-workspace mount',
      scriptProfile,
      (profile: Record<string, any>) => { profile.guest.workspaceMount = '/workspace'; },
      /must not declare a primary workspace/,
    ],
    [
      'a caller-supplied writable seed overlay',
      scriptProfile,
      (profile: Record<string, any>) => {
        profile.guest.mountEnforcement = {
          plans: [{ tag: 'enclave-seed', writableOverlays: [] }],
        };
      },
      /must use its closed export access modes/,
    ],
    [
      'an invalid vsock port',
      scriptProfile,
      (profile: Record<string, any>) => { profile.guest.vsockPort = 0; },
      /vsock port must be in 1-65535/,
    ],
    [
      'an unknown guest identity field',
      scriptProfile,
      (profile: Record<string, any>) => {
        profile.guest.identity = { uid: 1000, gid: 1000, groups: [1000] };
      },
      /Unknown Cloud Hypervisor guest identity field/,
    ],
    [
      'a root guest identity',
      scriptProfile,
      (profile: Record<string, any>) => {
        profile.guest.identity = { uid: 0, gid: 1000 };
      },
      /guest identity must be non-root/,
    ],
    [
      'a missing primary bridge',
      primaryProfile,
      (profile: Record<string, any>) => { profile.network.infrastructureBridge = ''; },
      /refusing to launch an unfiltered microVM/,
    ],
    [
      'an unsafe primary bridge',
      primaryProfile,
      (profile: Record<string, any>) => {
        profile.network.infrastructureBridge = 'bridge-name-too-long';
      },
      /Unsafe Cloud Hypervisor primary infrastructure bridge/,
    ],
    [
      'a control peer without ports',
      primaryProfile,
      (profile: Record<string, any>) => {
        profile.network.controlPeer = { ip: '172.30.0.60', ports: [] };
      },
      /must specify at least one port/,
    ],
    [
      'an invalid control peer port',
      primaryProfile,
      (profile: Record<string, any>) => {
        profile.network.controlPeers = [{ ip: '172.30.0.60', ports: [0] }];
      },
      /control peer port must be in 1-65535/,
    ],
    [
      'an unsafe host alias',
      primaryProfile,
      (profile: Record<string, any>) => {
        profile.network.hostAliases = { '-gateway': '172.30.0.60' };
      },
      /Unsafe Cloud Hypervisor host alias/,
    ],
    [
      'an unsupported API proxy engine',
      agentProfile,
      (profile: Record<string, any>) => { profile.network.apiProxy.engine = 'untrusted'; },
      /supported dedicated API proxy engine profile/,
    ],
    [
      'an unsafe owner identity',
      scriptProfile,
      (profile: Record<string, any>) => { profile.identity.ownerId = '../script'; },
      /Unsafe Cloud Hypervisor workload owner identity/,
    ],
  ])('rejects %s', (_name, create, mutate, expected) => {
    const profile = create();
    mutate(profile);
    expect(() => validateCloudHypervisorWorkloadProfile(profile as never)).toThrow(expected);
  });

  it('accepts singular and repeated primary control peers', () => {
    expect(createPrimaryAgentCloudHypervisorProfile({
      network: {
        infrastructureBridge: 'awfbr0',
        enableApiProxy: false,
        controlPeer: { ip: '172.30.0.60', ports: [8080] },
        controlPeers: [{ ip: '172.30.0.61', ports: [8081] }],
      },
    }).network).toMatchObject({
      controlPeer: { ip: '172.30.0.60', ports: [8080] },
      controlPeers: [{ ip: '172.30.0.61', ports: [8081] }],
    });
  });

  it('requires a profile object', () => {
    expect(() => validateCloudHypervisorWorkloadProfile(null as never)).toThrow(
      /workload profile is required/,
    );
  });

  it('keeps script-enclave execution fail-closed until host-executor integration', () => {
    const profile = createScriptEnclaveCloudHypervisorProfile({
      enclaveId: 'script-entry',
      invocationId: 'b'.repeat(32),
      guest: supervisor,
      exportPlan: exportPlan('script'),
    });
    expect(() => assertCloudHypervisorWorkloadLaunchable(profile)).toThrow(
      /not implemented; refusing to fall back/,
    );
  });

  it('keeps agent-enclave execution fail-closed until host-executor integration', () => {
    const profile = createAgentEnclaveCloudHypervisorProfile({
      enclaveId: 'agent-entry',
      invocationId: 'd'.repeat(32),
      guest: supervisor,
      exportPlan: exportPlan('agent'),
      apiProxy: { ip: '172.31.0.30', engine: 'copilot', profile: 'anthropic' },
    });
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
