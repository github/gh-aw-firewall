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

export function describeDeviceAclShape(entries: readonly string[]): string {
  const shape = entries
    .map((entry) => entry.replace(/^((?:user|group):)[0-9]+:/, '$1<id>:'))
    .join(',');
  return shape.length <= 512 ? shape : `${shape.slice(0, 509)}...`;
}

export function namedUserAclUid(entry: string): number | undefined {
  const match = /^user:([0-9]+):[rwx-]{3}$/.exec(entry);
  if (!match) return undefined;
  const uid = Number(match[1]);
  return Number.isSafeInteger(uid) && uid > 0 ? uid : undefined;
}

export function composeDeviceAcl(
  baseline: readonly string[],
  current: readonly string[],
  ownerUid: number,
  capturedTemporaryUids: readonly number[],
  liveTemporaryUids: readonly number[],
  accessedBaseline: readonly string[] = baseline,
  accessedTemporaryUids: readonly number[] = capturedTemporaryUids,
): string[] {
  parseDeviceAcl(baseline.join('\n'));
  parseDeviceAcl(current.join('\n'));
  parseDeviceAcl(accessedBaseline.join('\n'));
  const capturedTemporary = new Set(capturedTemporaryUids);
  const liveTemporary = new Set(liveTemporaryUids);
  capturedTemporary.add(ownerUid);
  liveTemporary.delete(ownerUid);

  const durable = baseline.filter((entry) => {
    const uid = namedUserAclUid(entry);
    return uid === undefined || !capturedTemporary.has(uid);
  });
  const durableNamedUsers = new Map<number, string>();
  for (const entry of durable) {
    const uid = namedUserAclUid(entry);
    if (uid !== undefined) durableNamedUsers.set(uid, entry);
  }
  const accessedTemporary = new Set(accessedTemporaryUids);
  accessedTemporary.add(ownerUid);
  for (const entry of accessedBaseline) {
    const uid = namedUserAclUid(entry);
    if (uid !== undefined && !accessedTemporary.has(uid) && !durableNamedUsers.has(uid)) {
      durableNamedUsers.set(uid, entry);
    }
  }
  const temporaryNamedUsers = new Map<number, string>();
  for (const entry of current) {
    const uid = namedUserAclUid(entry);
    if (uid === undefined || uid === ownerUid) continue;
    if (liveTemporary.has(uid)) {
      temporaryNamedUsers.set(uid, entry);
      continue;
    }
    if (!durableNamedUsers.has(uid)) {
      throw new Error(`Cloud Hypervisor device ACL contains an unowned user ACE: ${uid}`);
    }
  }

  const namedUsers = [
    ...durableNamedUsers.entries(),
    ...temporaryNamedUsers.entries(),
  ].sort(([left], [right]) => left - right)
    .map(([, entry]) => entry);
  const withoutNamedUsers = durable.filter((entry) => namedUserAclUid(entry) === undefined);
  const ownerIndex = withoutNamedUsers.findIndex((entry) => entry.startsWith('user::'));
  const composed = [
    ...withoutNamedUsers.slice(0, ownerIndex + 1),
    ...namedUsers,
    ...withoutNamedUsers.slice(ownerIndex + 1),
  ];

  if (temporaryNamedUsers.size > 0 || durableNamedUsers.size > 0) {
    const baselineMask = baseline.find((entry) => entry.startsWith('mask::'));
    const requiredMask = temporaryNamedUsers.size > 0
      ? current.find((entry) => entry.startsWith('mask::'))!
      : baselineMask ??
        accessedBaseline.find((entry) => entry.startsWith('mask::'))!;
    const maskIndex = composed.findIndex((entry) => entry.startsWith('mask::'));
    if (maskIndex >= 0) composed[maskIndex] = requiredMask;
    else {
      const otherIndex = composed.findIndex((entry) => entry.startsWith('other::'));
      composed.splice(otherIndex, 0, requiredMask);
    }
  }
  return parseDeviceAcl(composed.join('\n'));
}
