import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vm from 'vm';
import { execFileSync } from 'child_process';

const harness = fs.readFileSync(path.join(__dirname, 'nvx-phase4-campaign-runtime.sh'), 'utf8');
const identityCode = harness.split("<<'IDENTITY'\n")[1].split('\nIDENTITY')[0];

function captureIdentity(runtime: 'nvx' | 'cloud-hypervisor', corrupt?: (record: any) => void): any {
  const runId = 'a'.repeat(32);
  const cgroup = `/sys/fs/cgroup/awf-${runtime}/${runId}`;
  const runDirectory = `/runs/${runId}`;
  const processIdentity = {
    pid: 123, uid: 1001, executable: '/trusted/vmm',
    startTimeTicks: '456', startTime: '456', networkNamespace: 'net:[789]',
  };
  const fileIdentity = { device: '1', inode: '2' };
  const record = {
    runId, owner: { pid: 99 },
    vmmIdentity: { state: 'live', uid: 1001, name: 'awf-vmm' },
    network: { netnsPath: '/var/run/netns/awf' },
    resources: {
      openvmm: processIdentity,
      cgroup: { path: cgroup, ...fileIdentity },
      runDirectory: { path: runDirectory, ...fileIdentity },
    },
    paths: { cgroupPath: cgroup, runDirectory },
    identities: { runDirectory: fileIdentity, cgroup: fileIdentity },
    processes: { vmm: { identity: processIdentity } },
  };
  corrupt?.(record);
  let output;
  const procFields = ['S', ...Array(18).fill('0'), '456'].join(' ');
  const files: Record<string, string> = {
    '/proc/99/cmdline': 'node\0dist/cli.js\0--work-dir\0/sample/awf\0',
    '/proc/123/stat': `123 (vmm) ${procFields}`,
    '/proc/123/status': 'Uid:\t1001\t1001\t1001\t1001\n',
    '/proc/123/cgroup': `0::${cgroup.slice('/sys/fs/cgroup'.length)}\n`,
  };
  const mockFs = {
    readdirSync: () => ['run.json'],
    readFileSync: (file: string) => file.endsWith('/run.json') ? JSON.stringify(record) : files[file],
    readlinkSync: (file: string) => file.endsWith('/exe') ? '/trusted/vmm' : 'net:[789]',
    statSync: (file: string) => file === '/var/run/netns/awf' ? { ino: 789 } : { ino: 2n, dev: 1n },
    writeFileSync: (_file: string, contents: string) => { output = JSON.parse(contents); },
  };
  vm.runInNewContext(identityCode, {
    process: { argv: ['node', '-', runtime, '/sample/awf', '/evidence/identity.json'] },
    require: (name: string) => name === 'node:fs' ? mockFs : path,
  });
  return output;
}

describe('Phase 4 campaign runtime evidence', () => {
  it.each(['nvx', 'cloud-hypervisor'] as const)('captures the exact live %s owner and runtime', runtime => {
    expect(captureIdentity(runtime)).toMatchObject({
      pid: 123, uid: 1001, account: 'awf-vmm', networkNamespace: 'net:[789]',
    });
  });

  it.each(['nvx', 'cloud-hypervisor'] as const)('rejects stale or mismatched %s identities', runtime => {
    for (const corrupt of [
      (record: any) => { record.owner.pid = 100; },
      (record: any) => { record.vmmIdentity.uid = 1002; },
      (record: any) => { record.resources.openvmm.startTimeTicks = record.processes.vmm.identity.startTime = '457'; },
      (record: any) => { record.resources.openvmm.networkNamespace = 'net:[790]'; },
      (record: any) => { record.resources.cgroup.path = record.paths.cgroupPath = '/other-cgroup'; },
      (record: any) => { record.resources.runDirectory.inode = record.identities.runDirectory.inode = '3'; },
    ]) {
      expect(captureIdentity(runtime, corrupt)).toBeUndefined();
    }
  });

  it('rejects each shared concurrent runtime identity', () => {
    const filter = harness.split("if sudo jq -es '")[1].split("' \"$evidence_dir/runtime-identity.json\"")[0];
    const first = captureIdentity('nvx');
    const second = {
      runId: 'b'.repeat(32), pid: 124, uid: 1002, account: 'awf-peer',
      runDirectory: '/runs/peer', cgroup: '/cgroups/peer', networkNamespace: 'net:[790]',
    };
    const check = (peer: any) => execFileSync('jq', ['-s', filter], {
      input: `${JSON.stringify(first)}\n${JSON.stringify(peer)}`,
      encoding: 'utf8',
    }).trim();
    expect(check(second)).toBe('true');
    for (const field of Object.keys(second)) {
      expect(check({ ...second, [field]: first[field] })).toBe('false');
    }
    expect(harness).not.toContain('CONCURRENT_ISOLATION=true');
    expect(harness).toContain('run_peer >"$peer_log"');
    expect(harness).toContain('--env "AWF_PHASE4_CANARY_ROOT=$AWF_PHASE4_CANARY_ROOT/peer"');
    expect(harness).toMatch(/\n  fi\n  if \[ "\$mode" = concurrent \] && \[ -z "\$peer_pid" \]/);
  });

  it.each([
    ['nvx', false], ['cloud-hypervisor', false], ['nvx', true], ['cloud-hypervisor', true],
  ])('launches the %s peer without replacing primary sidecars (cleanup failure: %s)', async (runtime, cleanupFails) => {
    const peerCode = harness.split("<<'PEER'\n")[1].split('\nPEER')[0];
    const backend = {
      start: jest.fn(async () => {}),
      exec: jest.fn(async () => ({ exitCode: 0 })),
      stop: jest.fn(async () => { if (cleanupFails) throw new Error('cleanup failed'); }),
    };
    let startInfrastructure: () => Promise<void> = async () => {};
    const buildConfig = jest.fn(inputs => ({
      ...inputs, containerRuntime: runtime, workDir: '/peer-awf',
    }));
    const remove = jest.fn(async () => {});
    const processMock = { argv: ['node', '-'], on: jest.fn(), exitCode: undefined };
    const factory = jest.fn((_config, start) => { startInfrastructure = start; return backend; });
    const modules: Record<string, unknown> = {
      'node:fs/promises': { rm: remove },
      'node:path': path,
      [path.resolve('dist/cli-options.js')]: {
        program: {
          parse: jest.fn(), opts: () => ({ env: ['AWF_PHASE4_CANARY_ROOT=/workspace/peer'] }),
          args: ['/bin/sh /workspace/workload.sh'],
        },
      },
      [path.resolve('dist/commands/build-config.js')]: { buildConfig },
      [path.resolve('dist/logger.js')]: { logger: { setLevel: jest.fn() } },
      [path.resolve(`dist/${runtime}/runtime-backend.js`)]: {
        createNvxRuntimeBackend: factory, createCloudHypervisorRuntimeBackend: factory,
      },
    };
    const errors = jest.fn();
    await vm.runInNewContext(peerCode, {
      require: (name: string) => modules[name], process: processMock, console: { error: errors },
    });
    await expect(startInfrastructure()).resolves.toBeUndefined();
    expect(buildConfig.mock.calls[0][0].additionalEnv).toEqual({
      AWF_PHASE4_CANARY_ROOT: '/workspace/peer',
    });
    expect(backend.start).toHaveBeenCalledWith('/peer-awf', [], undefined);
    expect(backend.exec).toHaveBeenCalled();
    expect(backend.stop).toHaveBeenCalledTimes(1);
    if (cleanupFails) {
      expect(remove).not.toHaveBeenCalled();
      expect(errors).toHaveBeenCalled();
      expect(processMock.exitCode).toBe(1);
    } else {
      expect(remove).toHaveBeenCalledWith('/peer-awf', { recursive: true, force: true });
    }
    expect(harness).toContain('[ -f "$peer_workspace/workload-ended" ]');
  });

  it('compares positive scratch capacity against the configured limit, not usage', () => {
    const filter = harness.split("'all(.[]; (.scratchCapacityBytes | type)")[1].split("' \"${security_files[@]}\"")[0];
    const check = (capacity: unknown) => execFileSync('jq', [
      '-sr', '--argjson', 'limit', '1073741824',
      `all(.[]; (.scratchCapacityBytes | type)${filter}`,
    ], {
      input: JSON.stringify({ scratchCapacityBytes: capacity, scratchUsageBytes: 1 }),
      encoding: 'utf8',
    }).trim();
    expect(check(1073741824)).toBe('true');
    for (const capacity of [0, -1, 1073741825, '1073741824', null]) {
      expect(check(capacity)).toBe('false');
    }
    expect(harness).toContain('--nvx-scratch-bytes "$scratch_limit_bytes"');
    expect(harness).toContain('--cloud-hypervisor-scratch-mib "$scratch_mib"');
    expect(harness.indexOf(`' "$root/guest-preflight.json"`)).toBeLessThan(harness.indexOf('guest_stage=workload'));
  });

  it('aborts both release handshakes when a peer fails preflight or dies during launch', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phase4-abort-'));
    const abortBlock = harness.split('  if [ "$mode" = concurrent ] && [ -n "$peer_pid" ] &&')[1]
      .split('  if [ "$workload_released" = false ]')[0];
    try {
      fs.mkdirSync(path.join(root, 'peer'));
      fs.writeFileSync(path.join(root, 'peer', 'workload-ended'), '1');
      const check = (dead: boolean) => execFileSync('bash', ['-c', `
        mode=concurrent peer_pid=1 awf_pid=2 workload_released=false cleanup_released=false
        workspace_dir="$1"; peer_workspace="$1/peer"; dead="$2"
        kill() { [ "$dead" != true ]; }
        if [ "$mode" = concurrent ] && [ -n "$peer_pid" ] && ${abortBlock}
        test -f "$workspace_dir/workload-abort"
        test -f "$peer_workspace/workload-abort"
        test -f "$workspace_dir/cleanup-release"
        test -f "$peer_workspace/cleanup-release"
      `, '-', root, String(dead)]);
      expect(() => check(false)).not.toThrow();
      fs.writeFileSync(path.join(root, 'peer', 'guest-preflight.json'), '{}');
      fs.rmSync(path.join(root, 'workload-abort'));
      fs.rmSync(path.join(root, 'peer', 'workload-abort'));
      expect(() => check(true)).not.toThrow();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('classifies a transient network failure using pre-workload evidence and preserved logs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phase4-classification-'));
    try {
      const log = path.join(root, 'awf.log');
      fs.writeFileSync(log, 'HTTP 503\n');
      const classification = harness.split('failure_category="workload-failure"')[1].split('\njq -n')[0];
      const check = (overrides = '') => execFileSync('bash', ['-c', `
        awf_status=1 guest_ok=false observed_cgroup=/cgroup
        egress=true credential=true workspace=true concurrent_isolation=true
        runtime_selected_no_fallback=true immutable_artifacts=true bounded_scratch=true
        resource_limits=true kvm_restored=true
        residue=(); failure_logs=("$1")
        failure_category=workload-failure
        ${overrides}
        ${classification}
        printf '%s' "$failure_category"
      `, '-', log], { encoding: 'utf8' });
      expect(check()).toBe('network-infrastructure');
      for (const override of ['credential=false', 'bounded_scratch=false', 'concurrent_isolation=false', 'residue=(leak)']) {
        expect(check(override)).toBe('workload-failure');
      }
      expect(harness).toContain('failure_logs=("$raw_evidence_dir/awf.log")');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
