export function parseOperatorId(value: string | undefined, allowRoot = false): number | undefined {
  if (value === undefined || !/^(0|[1-9][0-9]*)$/.test(value)) return undefined;
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id >= 0xffffffff || (!allowRoot && id === 0)) return undefined;
  return id;
}

export function resolveOperatorIdentity(
  env: NodeJS.ProcessEnv = process.env,
): { uid: number; gid: number } | undefined {
  const uid = parseOperatorId(env.SUDO_UID) ?? parseOperatorId(process.getuid?.().toString());
  const gid = parseOperatorId(env.SUDO_GID) ?? parseOperatorId(process.getgid?.().toString());
  return uid === undefined || gid === undefined ? undefined : { uid, gid };
}
