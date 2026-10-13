import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { execFileSync } from 'child_process';

const checksPath = path.resolve(__dirname, 'nvx-phase4-runtime-checks.sh');
const recoveryPath = path.resolve(__dirname, 'nvx-phase4-recovery-runtime.sh');
const campaignPath = path.resolve(__dirname, 'nvx-phase4-campaign-runtime.sh');
const checks = fs.readFileSync(checksPath, 'utf8');
const recovery = fs.readFileSync(recoveryPath, 'utf8');
const campaign = fs.readFileSync(campaignPath, 'utf8');

function nodeCheck(name: string, argv: string[], files: Record<string, string>) {
  const body = checks.split(`${name}() {`)[1].split("<<'NODE'\n")[1].split('\nNODE')[0];
  const output: string[] = [];
  let status = 0;
  const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
  const get = (file: string) => {
    if (!(file in files)) throw missing();
    return files[file];
  };
  const exit = (code: number) => { status = code; throw new Error('exit'); };
  try {
    vm.runInNewContext(body.replace('} catch (error) {',
      '} catch (error) { if (error.message === "exit") throw error;'), {
      require: (name: string) => name === 'path' ? path : {
        readdirSync: () => [...new Set(Object.keys(files).map((file) => file.split('/')[2]))],
        readlinkSync: get,
        readFileSync: get,
      },
      process: { argv: ['node', '-', ...argv], exit },
      console: { log: (text: string) => output.push(text), error: () => undefined },
    });
  } catch (error) {
    if ((error as Error).message !== 'exit') throw error;
  }
  return { status, output: output.join('\n') };
}

function processFiles(pid: number, exe: string, argv: string[], startTime = '123', state = 'S') {
  return {
    [`/proc/${pid}/exe`]: exe,
    [`/proc/${pid}/cwd`]: '/repo',
    [`/proc/${pid}/cmdline`]: argv.join('\0'),
    [`/proc/${pid}/stat`]: `${pid} (node) ${[state, ...Array(18).fill('0'), startTime].join(' ')}`,
  };
}

async function cleanupIdentityCheck(runtime: string, defect = '') {
  const runId = 'a'.repeat(32);
  const snapshot = `/var/lib/awf-${runtime}/trusted-artifacts/run-${runId}`;
  const identity = (pid: number, executable: string) => ({
    pid, executable, startTimeTicks: pid === 31 ? '123' : '456',
    executableDevice: '11', executableInode: '12',
    uid: 0, gid: 0, networkNamespace: 'net:[1]',
  });
  const owner = identity(31, '/usr/bin/node');
  const vmm = identity(41, `${snapshot}/${runtime === 'nvx' ? 'openvmm' : 'cloud-hypervisor'}`);
  const normalize = (value: typeof owner) => ({
    ...value, startTime: value.startTimeTicks,
    executableIdentity: { device: value.executableDevice, inode: value.executableInode },
  });
  if (defect === 'wrong-executable') vmm.executable = '/usr/bin/node';
  const recordedVmm = {
    state: defect === 'pending' ? 'pending' : 'live',
    executable: vmm.executable, identity: normalize(vmm), socketPath: '/run/api.socket',
  };
  const record = runtime === 'nvx' ? {
    runId, owner,
    resources: { openvmm: defect === 'missing' ? undefined : vmm },
    stages: { processStarted: defect !== 'pending' },
  } : {
    runId, owner: normalize(owner),
    processes: { vmm: defect === 'missing' ? undefined : recordedVmm },
    paths: { artifactSnapshotDirectory: snapshot },
  };
  const processMatches = jest.fn(async (_dependencies, current: { pid: number }) =>
    defect !== 'changed-vmm' || current.pid !== 41);
  const processState = {
    argv: ['node', '-', runtime, '/cleanup/record.json', '/cleanup', '31', '123'],
    exitCode: 0,
  };
  const body = checks.split('awf_cleanup_identity_valid() {')[1]
    .split("<<'NODE'\n")[1].split('\nNODE')[0];
  await vm.runInNewContext(body, {
    require: (name: string) => {
      if (name === 'path') return path;
      if (name === 'fs') return {
        lstatSync: () => ({ isFile: () => true, uid: 0, mode: 0o600 }),
        readFileSync: () => JSON.stringify(record),
        promises: {},
      };
      if (name.endsWith('/nvx/cleanup-record.js')) {
        return { parseNvxCleanupRecord: () => record };
      }
      if (name.endsWith('/cloud-hypervisor/cleanup-identity.js')) {
        return { validateRecord: () => undefined };
      }
      if (name.endsWith('/cloud-hypervisor/cleanup-process.js')) return { processMatches };
      throw new Error(`Unexpected module: ${name}`);
    },
    process: processState,
    console: { error: () => undefined },
  });
  return { status: processState.exitCode, processMatches, recordedVmm };
}

describe('Phase 4 recovery manager selection', () => {
  const work = '/runner/recovery/sample/work';
  const cli = '/repo/dist/cli.js';
  const manager = processFiles(31, '/usr/bin/node', ['node', 'dist/cli.js', '--work-dir', work]);

  it('selects the exact Node CLI, never the sudo wrapper or another work-dir', () => {
    const files = {
      ...processFiles(30, '/usr/bin/sudo', ['sudo', 'node', 'dist/cli.js', '--work-dir', work]),
      ...processFiles(32, '/usr/bin/node', ['node', 'dist/cli.js', '--work-dir', `${work}-other`]),
      ...processFiles(33, '/usr/bin/node', ['node', 'other/cli.js', '--work-dir', work]),
      ...manager,
    };
    expect(nodeCheck('awf_manager_identity', [work, cli], files)).toEqual({
      status: 0, output: '31 123',
    });
  });

  it('fails closed on missing or ambiguous managers', () => {
    expect(nodeCheck('awf_manager_identity', [work, cli], {}).status).toBe(1);
    expect(nodeCheck('awf_manager_identity', [work, cli], {
      ...manager, ...processFiles(34, '/usr/bin/node', ['node', cli, '--work-dir', work]),
    }).status).toBe(1);
  });

  it('requires actual death and distinguishes PID reuse and zombies from a live manager', () => {
    expect(nodeCheck('awf_manager_alive', ['31', '123'], manager).status).toBe(0);
    expect(nodeCheck('awf_manager_alive', ['31', '123'], {}).status).toBe(1);
    expect(nodeCheck('awf_manager_alive', ['31', '124'], manager).status).toBe(1);
    expect(nodeCheck('awf_manager_alive', ['31', '123'],
      processFiles(31, '/usr/bin/node', [], '123', 'Z')).status).toBe(1);
    expect(recovery).toContain('wait "$launcher_pid"');
    expect(recovery).toContain('awf_manager_alive "$manager_pid" "$manager_start_time"');
    expect(recovery).not.toContain('sudo kill -KILL "$launcher_pid"');
  });

  it('uses the full trusted Cloud Hypervisor command for readiness', () => {
    expect(recovery).not.toContain('pgrep -x cloud-hypervisor');
    expect(recovery).toContain(
      "pgrep -f '/var/lib/awf-cloud-hypervisor/trusted-artifacts/run-[^/]*/[c]loud-hypervisor --api-socket'",
    );
  });

  it('validates journal provenance against the actual manager and gates stale-recovery success', () => {
    expect(checks).toContain('.parseNvxCleanupRecord(contents, recordPath, cleanupRoot)');
    expect(checks).toContain('.validateRecord(record, recordPath, cleanupRoot)');
    expect(checks).toContain('owner.pid !== Number(pid) || owner.startTime !== startTime');
    expect(checks).toContain('processMatches(fs.promises, owner)');
    expect(recovery).toContain('[ "$identity_checked" = true ]; then success=true');
    expect(recovery).toContain('failure_category=provenance');
    expect(recovery.indexOf('failure_category=provenance')).toBeGreaterThan(
      recovery.indexOf('failure_category=network-infrastructure'),
    );
  });

  it.each(['nvx', 'cloud-hypervisor'])(
    'matches the durable %s VMM process identity, not just the manager',
    async (runtime) => {
      const result = await cleanupIdentityCheck(runtime);
      expect(result.status).toBe(0);
      expect(result.processMatches).toHaveBeenCalledTimes(2);
      expect(result.processMatches.mock.calls[1][1]).toEqual(expect.objectContaining({
        pid: 41, startTime: '456', executableIdentity: { device: '11', inode: '12' },
      }));
      if (runtime === 'cloud-hypervisor') {
        expect(result.processMatches).toHaveBeenNthCalledWith(
          2, expect.anything(), expect.objectContaining({ pid: 41 }), result.recordedVmm,
        );
      }
    },
  );

  it.each([
    ['nvx', 'missing'], ['nvx', 'pending'], ['nvx', 'changed-vmm'], ['nvx', 'wrong-executable'],
    ['cloud-hypervisor', 'missing'], ['cloud-hypervisor', 'pending'],
    ['cloud-hypervisor', 'changed-vmm'], ['cloud-hypervisor', 'wrong-executable'],
  ])('rejects %s VMM identity defect: %s', async (runtime, defect) => {
    expect((await cleanupIdentityCheck(runtime, defect)).status).toBe(1);
  });

  it('accepts measured NVX stale-recovery runtime evidence without a manager exit log', () => {
    const assertion = recovery.slice(recovery.indexOf('runtime_no_fallback=false\n'),
      recovery.indexOf('immutable_artifacts=true\n'));
    const classification = recovery.slice(recovery.indexOf('success=false\n'),
      recovery.indexOf('if [ "${#residue[@]}" -eq 0 ]; then residue_json='));
    const result = execFileSync('/bin/bash', ['-c', `
      set -euo pipefail
      runtime=nvx kind=stale-recovery readiness=true cleanup_record_identity_valid=true
      terminal_observed=true manager_killed_after_record=true workload_after_recovery=true
      identity_checked=true guest_egress=true guest_credential=true guest_workspace=true
      immutable_artifacts=true bounded_scratch=true first_status=137 root=unused
      residue=()
      grep() { echo 'must not require an exit log' >&2; return 1; }
      ${assertion}
      ${classification}
      printf '%s %s' "$success" "$failure_category"
    `], { encoding: 'utf8' });
    expect(result).toBe('true success');
    expect(recovery).not.toContain('[nvx] Agent command exited');
  });

  it.each([
    ['cancellation', 'false'],
    ['stale-recovery', 'false'],
    ['stale-recovery', 'true'],
  ])(
    'classifies failed %s cleanup identity (record valid: %s) as nonretryable provenance',
    (kind, recordValid) => {
      const classification = recovery.slice(recovery.indexOf('success=false\n'),
        recovery.indexOf('if [ "${#residue[@]}" -eq 0 ]; then residue_json='));
      const result = execFileSync('/bin/bash', ['-c', `
        set -euo pipefail
        kind=$1
        readiness=true terminal_observed=true cleanup_record_identity_valid=$2
        guest_egress=true guest_credential=true guest_workspace=true
        runtime_no_fallback=true immutable_artifacts=true bounded_scratch=true
        manager_killed_after_record=true workload_after_recovery=true identity_checked=false
        first_status=137 root=unused
        residue=()
        grep() { return 0; }
        ${classification}
        printf '%s %s' "$success" "$failure_category"
      `, 'test', kind, recordValid], { encoding: 'utf8' });
      expect(result).toBe('false provenance');
    },
  );
});

describe('Phase 4 runtime storage residue', () => {
  it('configures a 2 GiB scratch limit for Cloud Hypervisor recovery', () => {
    expect(recovery).toContain('--cloud-hypervisor-scratch-mib 2048');
  });

  it.each([
    [-1, false],
    [0, false],
    [1, true],
    [2147483648, true],
    [2147483649, false],
  ])('requires a positive bounded scratch capacity (%s bytes)', (capacity, expected) => {
    const assertion = recovery.slice(recovery.indexOf('  if [ "$scratch_capacity"'),
      recovery.indexOf('\nfi\nruntime_no_fallback=false'));
    const result = execFileSync('/bin/bash', ['-c', `
      set -euo pipefail
      scratch_capacity=$1
      bounded_scratch=false
      ${assertion}
      printf '%s' "$bounded_scratch"
    `, 'test', String(capacity)], { encoding: 'utf8' });
    expect(result).toBe(String(expected));
  });

  const cases = [
    ['nvx', 'cleanup', '/var/lib/awf-nvx/cleanup'],
    ['nvx', 'run', '/var/lib/awf-nvx/runs'],
    ['nvx', 'scratch', '/var/lib/awf-nvx/runs'],
    ['nvx', 'snapshot', '/var/lib/awf-nvx/trusted-artifacts'],
    ['cloud-hypervisor', 'cleanup', '/run/awf-cloud-hypervisor/pending-cleanup'],
    ['cloud-hypervisor', 'run', '/run/awf-cloud-hypervisor/cloud-hypervisor'],
    ['cloud-hypervisor', 'run', '/run/awf-cloud-hypervisor/virtiofsd'],
    ['cloud-hypervisor', 'scratch', '/run/awf-cloud-hypervisor/cloud-hypervisor'],
    ['cloud-hypervisor', 'snapshot', '/var/lib/awf-cloud-hypervisor/trusted-artifacts'],
  ];

  it.each(cases)('detects %s %s residue in %s even after work-dir removal', (runtime, category, root) => {
    const result = execFileSync('/bin/bash', ['-s', '--', runtime, category, root], {
      encoding: 'utf8',
      input: `${checks}
      set -euo pipefail
      sudo() {
        if [ "$1" = test ]; then return 0; fi
        if [ "$1" = find ] && [ "$2" = "$RESIDUE_ROOT" ] && [ "$residue" = true ]; then
          printf '%s/owned-entry 1:42 f\\n' "$2"
        fi
      }
      RESIDUE_ROOT=$3
      residue=false
      before=$(runtime_storage_snapshot "$1" "$2")
      residue=true
      after=$(runtime_storage_snapshot "$1" "$2")
      test "$before" != "$after"
      printf '%s' "$after"
    `,
    });
    expect(result).toBe(`${root}/owned-entry 1:42 f`);
  });

  it('checks every storage category before completing campaign cleanup', () => {
    for (const variable of ['cleanup', 'runs', 'scratch', 'snapshots']) {
      expect(campaign).toContain(`[ "$${variable}_before" = "$${variable}_after" ]`);
      expect(recovery).toContain(`[ "$${variable}_before" = "$${variable}_after" ]`);
    }
    expect(recovery).not.toContain('snapshot_removed=$run_removed');
    expect(campaign).toContain('residue+=("cleanup-record")');
    expect(campaign).toContain('residue+=("trusted-artifact-snapshot")');
    expect(checks).toContain('-name scratch.ext4 -o -name rootfs.ext4');
  });

  it('passes bash syntax checks', () => {
    for (const script of [checksPath, recoveryPath, campaignPath]) {
      execFileSync('/bin/bash', ['-n'], { input: fs.readFileSync(script, 'utf8') });
    }
  });
});
