#!/usr/bin/env bash

# Compare owned entries, not persistent empty parent directories.
runtime_storage_snapshot() {
  local runtime=$1 category=$2 root
  local roots=()
  case "$runtime:$category" in
    nvx:cleanup) roots=(/var/lib/awf-nvx/cleanup) ;;
    nvx:run|nvx:scratch) roots=(/var/lib/awf-nvx/runs) ;;
    nvx:snapshot) roots=(/var/lib/awf-nvx/trusted-artifacts) ;;
    cloud-hypervisor:cleanup) roots=(/run/awf-cloud-hypervisor/pending-cleanup) ;;
    cloud-hypervisor:run|cloud-hypervisor:scratch)
      roots=(
        "/run/awf-cloud-hypervisor/$(basename "${GH_AW_CLOUD_HYPERVISOR_BINARY:-cloud-hypervisor}")"
        /run/awf-cloud-hypervisor/virtiofsd
        /run/awf-cloud-hypervisor/enclave-storage
      )
      ;;
    cloud-hypervisor:snapshot) roots=(/var/lib/awf-cloud-hypervisor/trusted-artifacts) ;;
    *) return 2 ;;
  esac
  for root in "${roots[@]}"; do
    if sudo test -e "$root" || sudo test -L "$root"; then
      if [ "$category" = scratch ]; then
        sudo find "$root" -mindepth 1 \
          \( -name scratch.ext4 -o -name rootfs.ext4 \) -printf '%p %D:%i %y\n'
      else
        sudo find "$root" -mindepth 1 -maxdepth 1 -printf '%p %D:%i %y\n'
      fi
    fi
  done | sort
}

awf_cleanup_identity() {
  sudo node - "$@" <<'NODE'
const fs = require('fs');
const path = require('path');
const [runtime, cleanupRoot] = process.argv.slice(2);
(async () => {
const matches = [];
for (const name of fs.readdirSync(cleanupRoot)) {
  if (!/^[A-Za-z0-9_.-]+\.json$/.test(name)) continue;
  const recordPath = path.join(cleanupRoot, name);
  try {
    const stat = fs.lstatSync(recordPath);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o777) !== 0o600) continue;
    const contents = fs.readFileSync(recordPath, 'utf8');
    let record;
    if (runtime === 'nvx') {
      record = require(path.resolve('dist/nvx/cleanup-record.js'))
        .parseNvxCleanupRecord(contents, recordPath, cleanupRoot);
    } else {
      record = JSON.parse(contents);
      require(path.resolve('dist/cloud-hypervisor/cleanup-identity.js'))
        .validateRecord(record, recordPath, cleanupRoot);
    }
    const normalizeNvxProcess = (identity) => ({
      ...identity,
      startTime: identity.startTimeTicks,
      executableIdentity: {
        device: identity.executableDevice,
        inode: identity.executableInode,
      },
    });
    const owner = runtime === 'nvx' ? normalizeNvxProcess(record.owner) : record.owner;
    const { processMatches } = require(path.resolve('dist/cloud-hypervisor/cleanup-process.js'));
    if (!await processMatches(fs.promises, owner)) continue;
    if (runtime === 'nvx') {
      const launcher = record.resources.launcher;
      if (!record.stages.processStarted || !launcher ||
        !await processMatches(fs.promises, normalizeNvxProcess(launcher))) continue;
    } else {
      const vmm = record.processes.vmm;
      const snapshot = record.paths.artifactSnapshotDirectory;
      if (!snapshot || vmm?.state !== 'live' || !vmm.identity ||
        vmm.executable !== path.join(snapshot, 'cloud-hypervisor') ||
        vmm.identity.executable !== vmm.executable ||
        !await processMatches(fs.promises, vmm.identity, vmm)) continue;
    }
    matches.push([recordPath, owner.pid, owner.startTime]);
  } catch (error) {
    if (!['ENOENT', 'ESRCH'].includes(error.code)) console.error(error);
  }
}
if (matches.length !== 1) process.exit(1);
console.log(matches[0].join('\t'));
})().catch((error) => { console.error(error); process.exitCode = 1; });
NODE
}

awf_manager_alive() {
  sudo node - "$1" "$2" <<'NODE'
const fs = require('fs');
const [pid, startTime] = process.argv.slice(2);
try {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  process.exit(fields[0] !== 'Z' && fields[19] === startTime ? 0 : 1);
} catch (error) {
  if (['ENOENT', 'ESRCH'].includes(error.code)) process.exit(1);
  console.error(error);
  process.exit(2);
}
NODE
}

awf_cleanup_identity_valid() {
  sudo node - "$@" <<'NODE'
const fs = require('fs');
const path = require('path');
const [runtime, recordPath, cleanupRoot, pid, startTime] = process.argv.slice(2);
(async () => {
  const stat = fs.lstatSync(recordPath);
  if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o777) !== 0o600) {
    throw new Error('Cleanup record is not a root-owned private regular file');
  }
  const contents = fs.readFileSync(recordPath, 'utf8');
  let record;
  if (runtime === 'nvx') {
    record = require(path.resolve('dist/nvx/cleanup-record.js'))
      .parseNvxCleanupRecord(contents, recordPath, cleanupRoot);
  } else {
    record = JSON.parse(contents);
    require(path.resolve('dist/cloud-hypervisor/cleanup-identity.js'))
      .validateRecord(record, recordPath, cleanupRoot);
  }
  const normalizeNvxProcess = (identity) => ({
    ...identity,
    startTime: identity.startTimeTicks,
    executableIdentity: {
      device: identity.executableDevice,
      inode: identity.executableInode,
    },
  });
  const owner = runtime === 'nvx' ? normalizeNvxProcess(record.owner) : record.owner;
  if (owner.pid !== Number(pid) || owner.startTime !== startTime) {
    throw new Error('Cleanup record does not belong to the exact AWF manager');
  }
  const { processMatches } = require(path.resolve('dist/cloud-hypervisor/cleanup-process.js'));
  if (!await processMatches(fs.promises, owner)) {
    throw new Error('Cleanup owner process identity changed');
  }
  if (runtime === 'nvx') {
    const launcher = record.resources.launcher;
    if (!record.stages.processStarted || !launcher ||
      !await processMatches(fs.promises, normalizeNvxProcess(launcher))) {
      throw new Error('NVX live runtime launcher identity is missing or changed');
    }
  } else {
    const vmm = record.processes.vmm;
    const snapshot = record.paths.artifactSnapshotDirectory;
    if (!snapshot || vmm?.state !== 'live' || !vmm.identity ||
      vmm.executable !== path.join(snapshot, 'cloud-hypervisor') ||
      vmm.identity.executable !== vmm.executable ||
      !await processMatches(fs.promises, vmm.identity, vmm)) {
      throw new Error('Cloud Hypervisor live VMM process identity is missing or changed');
    }
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
NODE
}
