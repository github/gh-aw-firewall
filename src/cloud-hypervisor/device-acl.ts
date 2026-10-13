export type CloudHypervisorDevicePath = '/dev/kvm' | '/dev/net/tun';

const ACL_ENTRY = /^(?:user:(?:[0-9]+)?:[rwx-]{3}|group:(?:[0-9]+)?:[rwx-]{3}|mask::[rwx-]{3}|other::[rwx-]{3})$/;

export function parseDeviceAcl(contents: string): string[] {
  const entries = contents.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  const normalized = entries.map((entry) =>
    entry.replace(/\s+#effective:[rwx-]{3}$/, ''));
  if (
    normalized.length < 3 ||
    normalized.some((entry) => !ACL_ENTRY.test(entry)) ||
    normalized.filter((entry) => entry.startsWith('user::')).length !== 1 ||
    normalized.filter((entry) => entry.startsWith('group::')).length !== 1 ||
    normalized.filter((entry) => entry.startsWith('other::')).length !== 1 ||
    normalized.filter((entry) => entry.startsWith('mask::')).length > 1 ||
    new Set(normalized).size !== normalized.length
  ) {
    throw new Error('Cloud Hypervisor device ACL is malformed');
  }
  const hasNamedEntry = normalized.some((entry) =>
    /^(?:user|group):[0-9]+:/.test(entry));
  if (hasNamedEntry && !normalized.some((entry) => entry.startsWith('mask::'))) {
    throw new Error('Cloud Hypervisor device ACL mask is inconsistent');
  }
  return normalized;
}

export function deviceAclArgument(entries: readonly string[]): string {
  parseDeviceAcl(entries.join('\n'));
  return entries.join(',');
}

export function sameDeviceAcl(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length &&
    left.every((entry, index) => entry === right[index]);
}
