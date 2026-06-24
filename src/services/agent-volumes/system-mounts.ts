function normalizeChrootBinariesSourcePath(chrootBinariesSourcePath?: string): string | undefined {
  if (!chrootBinariesSourcePath) {
    return undefined;
  }
  const trimmed = chrootBinariesSourcePath.trim();
  if (!trimmed || !trimmed.startsWith('/')) {
    return undefined;
  }
  const normalized = trimmed.replace(/\/+$/, '') || '/';
  return normalized === '/' ? undefined : normalized;
}

export function buildSystemMounts(workspaceDir: string, chrootBinariesSourcePath?: string): string[] {
  const mounts = [
    '/usr:/host/usr:ro',
    '/bin:/host/bin:ro',
    '/sbin:/host/sbin:ro',
    '/lib:/host/lib:ro',
    '/lib64:/host/lib64:ro',
    '/opt:/host/opt:ro',
    '/sys:/host/sys:ro',
    '/dev:/host/dev:ro',
    `${workspaceDir}:/host${workspaceDir}:rw`,
    '/tmp:/host/tmp:rw',
  ];

  const normalizedBinariesPath = normalizeChrootBinariesSourcePath(chrootBinariesSourcePath);
  if (normalizedBinariesPath) {
    // Mount under /host/tmp/awf-runner-bin (not /host/usr/local/bin) so Docker can
    // always create the mount-point directory. /host/usr is mounted read-only, so
    // Docker cannot mkdir /host/usr/local/bin after that parent mount is applied —
    // which fails in DinD/ARC setups where the staged /usr tree lacks local/bin.
    // /host/tmp is mounted read-write (/tmp:/host/tmp:rw), so subdirectory creation
    // always succeeds regardless of the host's staged /tmp content.
    // entrypoint.sh detects /host/tmp/awf-runner-bin and adds /tmp/awf-runner-bin
    // to the chroot PATH automatically.
    mounts.push(`${normalizedBinariesPath}:/host/tmp/awf-runner-bin:ro`);
  }

  return mounts;
}
