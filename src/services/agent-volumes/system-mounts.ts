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
    mounts.push(`${normalizedBinariesPath}:/host/usr/local/bin:ro`);
  }

  return mounts;
}
