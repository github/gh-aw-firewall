import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vm from 'vm';
import { execFileSync } from 'child_process';

const harness = fs.readFileSync(path.join(__dirname, 'nvx-phase4-campaign-runtime.sh'), 'utf8');
const identityCode = harness.split("<<'IDENTITY'\n")[1].split('\nIDENTITY')[0];

function extractShellFunction(name: string): string {
  const start = harness.indexOf(`${name}() {`);
  const next = harness.indexOf('\n}\n', start);
  if (start < 0 || next < 0) throw new Error(`missing shell function ${name}`);
  return harness.slice(start, next + 3);
}

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
  it('uses the post-provision runtime ACL baseline for workload assertions and restoration', () => {
    expect(harness).toContain('sudo cat "$AWF_PHASE4_KVM_RUNTIME_ACL_BASELINE"');
    expect(harness).not.toContain('AWF_PHASE4_KVM_HOST_ACL_BASELINE');
    expect(harness.indexOf('kvm_acl_before=')).toBeLessThan(harness.indexOf('trap restore_kvm_acl EXIT'));
    expect(harness.indexOf('kvm_acl_after=')).toBeLessThan(harness.indexOf('restore_kvm_acl\n'));
    expect(harness).toContain('nvx-phase4-kvm-acl-evidence.ts');
    expect(harness).toContain('"$evidence_dir/kvm-acl-diagnostics-$sample_id.json"');
    expect(harness).not.toContain('"$evidence_dir/kvm-acl-before.txt"');
    expect(harness).not.toContain('"$evidence_dir/kvm-acl-after.txt"');
    expect(harness.indexOf('nvx-phase4-kvm-acl-evidence.ts')).toBeLessThan(
      harness.indexOf('restore_kvm_acl\n'),
    );
    const output = harness.match(/"\$evidence_dir\/(kvm-acl-diagnostics-\$sample_id\.json)"/);
    expect(output).not.toBeNull();
    const outputFor = (sampleId: string) => output![1].replace('$sample_id', sampleId);
    expect(outputFor('sample-a')).not.toBe(outputFor('sample-b'));
  });

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
      runDirectory: '/runs/peer', cleanupRecord: '/cleanup/peer.json',
      cgroup: '/cgroups/peer', networkNamespace: 'net:[790]',
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
    expect(harness).toContain('--network-isolation --enable-api-proxy');
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
    expect(buildConfig.mock.calls[0][0].options.networkIsolation).toBe(true);
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
    expect(harness).toContain('peer-runtime-identity.json');
    expect(harness).toContain('for marker in workload-ended workload-abort runtime-ready');
    expect(harness).toContain('[ -e "$peer_workspace/$marker" ]');
    expect(harness).toContain('(map(.cleanupRecord) | unique | length == 2)');
    expect(harness).toContain('! sudo test -e "$primary_cleanup_record"');
    expect(harness).toContain('! sudo test -e "$peer_cleanup_record"');
    expect(harness).toContain('residue+=("cleanup-record:primary")');
    expect(harness).toContain('residue+=("cleanup-record:peer")');
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

  it.each([
    ['nvx', 'sequential', 128, 256],
    ['nvx', 'sequential', 256, 256],
    ['nvx', 'sequential', 512, 256],
    ['nvx', 'concurrent', 128, 256],
    ['nvx', 'concurrent', 256, 256],
    ['nvx', 'concurrent', 512, 256],
    ['cloud-hypervisor', 'sequential', 128, 128],
    ['cloud-hypervisor', 'sequential', 256, 256],
    ['cloud-hypervisor', 'sequential', 512, 512],
    ['cloud-hypervisor', 'concurrent', 128, 128],
    ['cloud-hypervisor', 'concurrent', 256, 256],
    ['cloud-hypervisor', 'concurrent', 512, 512],
  ])(
    'validates %s %s host and guest PID limits independently for profile %s',
    (runtime, mode, profilePidsMax, hostPidsMax) => {
      const guestFunction = extractShellFunction('guest_resource_limits_match');
      const resourceFunction = extractShellFunction('campaign_resource_limits_enforced');
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phase4-resources-'));
      const primary = path.join(root, 'primary.json');
      const peer = path.join(root, 'peer.json');
      const guestPidsMax = runtime === 'nvx' ? profilePidsMax : null;
      const guestKernelPidsMax = runtime === 'nvx' ? profilePidsMax + 1 : null;
      const probeTarget = runtime === 'nvx' ? profilePidsMax * 2 : null;
      const probeStarted = runtime === 'nvx' ? profilePidsMax - 2 : null;
      for (const file of [primary, peer]) {
        fs.writeFileSync(file, JSON.stringify({
          runtime, configuredPidsMax: profilePidsMax, pidsMax: guestPidsMax,
          kernelPidsMax: guestKernelPidsMax, probeTarget, probeStarted,
        }));
      }
      const run = (hostPids: number, guestFile = primary, peerHostPids = hostPidsMax) =>
        execFileSync('bash', ['-c', `
          ${guestFunction}
          ${resourceFunction}
          guest=false peer_guest=true
          if guest_resource_limits_match "$1" "$2" "$3"; then guest=true; fi
          if [ "$4" = concurrent ] &&
             ! guest_resource_limits_match "$1" "$2" "$5"; then peer_guest=false; fi
          campaign_resource_limits_enforced "$4" 4563402752 "200000 100000" "$6" \
            "$guest" /cgroup 4563402752 "200000 100000" "$7" \
            "$peer_guest" /peer 4563402752 "200000 100000" "$8"
        `, '-', runtime, String(profilePidsMax), guestFile, mode, peer,
        String(hostPidsMax), String(hostPids), String(peerHostPids)]);
      try {
        expect(() => run(hostPidsMax)).not.toThrow();
        expect(() => run(profilePidsMax === hostPidsMax ? hostPidsMax + 1 : profilePidsMax)).toThrow();
        fs.writeFileSync(primary, JSON.stringify({
          runtime, configuredPidsMax: profilePidsMax + 1, pidsMax: guestPidsMax,
          kernelPidsMax: guestKernelPidsMax, probeTarget, probeStarted,
        }));
        expect(() => run(hostPidsMax)).toThrow();
        if (mode === 'concurrent') {
          fs.writeFileSync(primary, JSON.stringify({
            runtime, configuredPidsMax: profilePidsMax, pidsMax: guestPidsMax,
            kernelPidsMax: guestKernelPidsMax, probeTarget, probeStarted,
          }));
          expect(() => run(hostPidsMax, peer, hostPidsMax + 1)).toThrow();
          if (runtime === 'nvx') {
            fs.writeFileSync(peer, JSON.stringify({
              runtime, configuredPidsMax: profilePidsMax, pidsMax: guestPidsMax,
              kernelPidsMax: profilePidsMax + 2, probeTarget, probeStarted,
            }));
            expect(() => run(hostPidsMax)).toThrow();
            fs.writeFileSync(peer, JSON.stringify({
              runtime, configuredPidsMax: profilePidsMax, pidsMax: guestPidsMax,
              kernelPidsMax: guestKernelPidsMax, probeTarget, probeStarted,
            }));
            fs.writeFileSync(peer, JSON.stringify({
              runtime, configuredPidsMax: profilePidsMax, pidsMax: guestPidsMax,
              kernelPidsMax: guestKernelPidsMax, probeTarget,
              probeStarted: profilePidsMax - 1,
            }));
            expect(() => run(hostPidsMax)).toThrow();
            fs.writeFileSync(peer, JSON.stringify({
              runtime, configuredPidsMax: profilePidsMax, pidsMax: guestPidsMax,
              kernelPidsMax: guestKernelPidsMax, probeTarget, probeStarted,
            }));
          }
        }
        if (runtime === 'nvx') {
          fs.writeFileSync(primary, JSON.stringify({
            runtime, configuredPidsMax: profilePidsMax, pidsMax: guestPidsMax,
            kernelPidsMax: profilePidsMax + 2, probeTarget, probeStarted,
          }));
          expect(() => run(hostPidsMax)).toThrow();
          fs.writeFileSync(primary, JSON.stringify({
            runtime, configuredPidsMax: profilePidsMax, pidsMax: guestPidsMax,
            kernelPidsMax: guestKernelPidsMax, probeTarget,
            probeStarted: profilePidsMax * 2,
          }));
          expect(() => run(hostPidsMax)).toThrow();
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each([128, 256, 512])(
    'validates NVX profile %s from immutable command line and bounded probe evidence',
    profilePidsMax => {
      const readGuestEvidence = extractShellFunction('read_nvx_guest_pids_evidence');
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phase4-guest-cgroup-'));
      const cmdline = path.join(root, 'cmdline');
      const probe = path.join(root, 'probe');
      fs.writeFileSync(cmdline, `quiet nvx_pids_max=${profilePidsMax + 1} console=ttyS0`);
      const run = (probeStarted = profilePidsMax - 2) => execFileSync('bash', ['-c', `
        guest_fail() { exit "$1"; }
        probe_nvx_guest_pids_limit() { printf '%s\\n' "$PROBE_STARTED" >"$2"; }
        ${readGuestEvidence}
        read_nvx_guest_pids_evidence "$1" "$2" "$3"
      `, '-', cmdline, String(profilePidsMax), probe], {
        encoding: 'utf8',
        env: { ...process.env, PROBE_STARTED: String(probeStarted) },
      }).trim();
      try {
        expect(run()).toBe(
          `${profilePidsMax} ${profilePidsMax + 1} ${profilePidsMax * 2} ${profilePidsMax - 2}`,
        );
        expect(() => run(profilePidsMax - 1)).toThrow();
        for (const invalid of [
          '', 'quiet', 'nvx_pids_max=0', 'nvx_pids_max=bad',
          `nvx_pids_max=${profilePidsMax}`,
          `nvx_pids_max=${profilePidsMax + 1} nvx_pids_max=${profilePidsMax + 1}`,
        ]) {
          fs.writeFileSync(cmdline, invalid);
          expect(run).toThrow();
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
      expect(harness).not.toContain('/proc/self/cgroup');
      expect(harness).not.toContain('guest_cgroup_pids_file');
      expect(harness).toContain('probe_nvx_guest_pids_limit');
      expect(harness).toContain('sleep 600 &');
      expect(harness).toContain('"$((configured_pids_max - 2))"');
      expect(harness).toContain('configuredPidsMax: Number(process.env.AWF_PHASE4_PROFILE_PIDS_MAX)');
      expect(harness).toContain('pidsMax: process.env.GUEST_PIDS_MAX ? Number(process.env.GUEST_PIDS_MAX) : null');
      expect(harness).toContain('Number(process.env.GUEST_KERNEL_PIDS_MAX) : null');
      expect(harness).toContain('Number(process.env.GUEST_PID_PROBE_STARTED) : null');
      expect(harness).toContain('--env "AWF_PHASE4_PROFILE_PIDS_MAX=$pids_max"');
      expect(harness).toContain('--env "AWF_PHASE4_RUNTIME=$runtime"');
      expect(harness).toContain('expectedPidsMax:$expectedHostPidsMax');
      expect(harness).toContain('observedKernelPidsMax:$guestKernelPidsMax');
    },
  );

  it('keeps generated guest PID evidence collection POSIX-compatible and within the probe budget', () => {
    const workload = harness.split('cat > "$workspace_dir/workload.sh" <<\'EOF\'\n')[1]
      .split('\nEOF')[0];
    expect(() => execFileSync('sh', ['-n'], { input: workload })).not.toThrow();
    expect(workload).toMatch(
      /read_nvx_guest_pids_evidence \\\n\s+\/proc\/cmdline "\$AWF_PHASE4_PROFILE_PIDS_MAX" \/tmp\/nvx-pids-probe-started \\\n\s+>"\$guest_pids_evidence_file"/,
    );
    expect(workload).toMatch(
      /read -r guest_pids_max guest_kernel_pids_max \\\n\s+guest_probe_target guest_probe_started <"\$guest_pids_evidence_file"/,
    );
    expect(workload).not.toContain('<<<');
    expect(workload).not.toContain('guest_pids_evidence=$(');
  });

  it.each([
    ['sequential', 'primary'],
    ['concurrent', 'primary'],
    ['concurrent', 'peer'],
  ])('keeps %s failure collection alive when %s guest evidence is missing', (mode, missing) => {
    const readObservations = extractShellFunction('read_guest_pids_observations');
    const collectObservations = extractShellFunction('collect_guest_pids_observations');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phase4-missing-evidence-'));
    const primary = path.join(root, 'primary');
    const peer = path.join(root, 'peer');
    fs.mkdirSync(primary);
    fs.mkdirSync(peer);
    const evidence = JSON.stringify({
      pidsMax: 256, kernelPidsMax: 257, probeTarget: 512, probeStarted: 254,
    });
    if (missing !== 'primary') fs.writeFileSync(path.join(primary, 'guest-preflight.json'), evidence);
    if (missing !== 'peer') fs.writeFileSync(path.join(peer, 'guest-preflight.json'), evidence);
    try {
      const output = execFileSync('bash', ['-c', `
        set -e
        ${readObservations}
        ${collectObservations}
        mode="$1"; workspace_dir="$2"; peer_workspace="$3"; resource_limits=true
        guest_pids_max=stale guest_kernel_pids_max=stale
        guest_probe_target=stale guest_probe_started=stale
        peer_guest_pids_max=stale peer_guest_kernel_pids_max=stale
        peer_guest_probe_target=stale peer_guest_probe_started=stale
        collect_guest_pids_observations
        printf '%s|%s|%s|%s|%s' "$resource_limits" "$guest_pids_max" \
          "$guest_kernel_pids_max" "$peer_guest_pids_max" "$peer_guest_kernel_pids_max"
        printf '|collection-continued'
      `, '-', mode, primary, peer], { encoding: 'utf8' });
      expect(output).toContain('false|');
      expect(output).toContain('|collection-continued');
      if (missing === 'primary') expect(output).toMatch(/^false\|\|/);
      if (missing === 'peer') expect(output).toMatch(/\|\|collection-continued$/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['sequential', 'primary'],
    ['concurrent', 'primary'],
    ['concurrent', 'peer'],
  ])('keeps %s failure collection alive when %s guest evidence is malformed', (mode, malformed) => {
    const readObservations = extractShellFunction('read_guest_pids_observations');
    const collectObservations = extractShellFunction('collect_guest_pids_observations');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phase4-malformed-evidence-'));
    const primary = path.join(root, 'primary');
    const peer = path.join(root, 'peer');
    fs.mkdirSync(primary);
    fs.mkdirSync(peer);
    const evidence = JSON.stringify({
      pidsMax: 256, kernelPidsMax: 257, probeTarget: 512, probeStarted: 254,
    });
    fs.writeFileSync(
      path.join(primary, 'guest-preflight.json'),
      malformed === 'primary' ? '{"pidsMax":' : evidence,
    );
    fs.writeFileSync(
      path.join(peer, 'guest-preflight.json'),
      malformed === 'peer' ? '{"kernelPidsMax":' : evidence,
    );
    try {
      const output = execFileSync('bash', ['-c', `
        set -e
        ${readObservations}
        ${collectObservations}
        mode="$1"; workspace_dir="$2"; peer_workspace="$3"; resource_limits=true
        collect_guest_pids_observations 2>/dev/null
        printf '%s|collection-continued' "$resource_limits"
      `, '-', mode, primary, peer], { encoding: 'utf8' });
      expect(output).toBe('false|collection-continued');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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
