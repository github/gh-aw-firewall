export function buildEtcMounts(): string[] {
  return [
    '/etc/ssl:/host/etc/ssl:ro',
    '/etc/ca-certificates:/host/etc/ca-certificates:ro',
    '/etc/alternatives:/host/etc/alternatives:ro',
    '/etc/ld.so.cache:/host/etc/ld.so.cache:ro',
    '/etc/passwd:/host/etc/passwd:ro',
    '/etc/group:/host/etc/group:ro',
    '/etc/nsswitch.conf:/host/etc/nsswitch.conf:ro',
  ];
}
