export function buildSystemMounts(workspaceDir: string): string[] {
  return [
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
}
