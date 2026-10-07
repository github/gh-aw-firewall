/**
 * Shared account resolution/validation for privileged VMM identities.
 *
 * Both the Cloud Hypervisor VMM identity path and the NVX runtime lifecycle path allocate a
 * dedicated system account and then must prove, before trusting it, that the account carries no
 * inherited supplementary groups and that its passwd entry matches the expected locked-down
 * shape. This module owns that shared `id`/`getent` parsing and safety checks; callers supply
 * their own positive-integer parser (error wording differs slightly between call sites) and may
 * layer additional passwd assertions (e.g. NVX's run-id home-directory constraint) via
 * `assertPasswdState`.
 */

export interface VmmAccountIdentity {
  readonly name: string;
  readonly uid: number;
  readonly gid: number;
}

export interface ResolveAndValidateVmmAccountOptions {
  /** The system account name to resolve and validate. */
  readonly name: string;
  /** Human-readable label used in thrown error messages, e.g. "Cloud Hypervisor VMM" or "NVX VMM". */
  readonly accountLabel: string;
  readonly tools: {
    readonly id: string;
    readonly getent: string;
  };
  readonly run: (
    command: string,
    args: readonly string[],
  ) => Promise<{ stdout: string; stderr: string }>;
  readonly parsePositiveInteger: (value: string, label: string) => number;
  /**
   * Optional extra passwd-entry assertion applied after the shared safety checks pass.
   * Receives the parsed passwd fields and the resolved uid/gid, and should throw to reject.
   */
  readonly assertPasswdState?: (
    passwd: readonly string[],
    identity: { readonly uid: number; readonly gid: number },
  ) => void;
}

export async function resolveAndValidateVmmAccount(
  options: ResolveAndValidateVmmAccountOptions,
): Promise<VmmAccountIdentity> {
  const { name, accountLabel, tools, run, parsePositiveInteger, assertPasswdState } = options;
  const [
    { stdout: uidText },
    { stdout: gidText },
    { stdout: groupsText },
    { stdout: passwdText },
  ] = await Promise.all([
    run(tools.id, ['-u', name]),
    run(tools.id, ['-g', name]),
    run(tools.id, ['-G', name]),
    run(tools.getent, ['passwd', name]),
  ]);
  const uid = parsePositiveInteger(uidText, 'uid');
  const gid = parsePositiveInteger(gidText, 'gid');
  const groups = groupsText.trim().split(/\s+/).filter(Boolean).map((value) =>
    parsePositiveInteger(value, 'supplementary group'));
  if (groups.length !== 1 || groups[0] !== gid) {
    throw new Error(
      `${accountLabel} account ${name} inherited supplementary groups: ${groups.join(' ')}`,
    );
  }
  const passwd = passwdText.trim().split(':');
  if (
    passwd.length !== 7 ||
    passwd[0] !== name ||
    passwd[2] !== String(uid) ||
    passwd[3] !== String(gid) ||
    passwd[5] !== '/nonexistent' ||
    passwd[6] !== '/usr/sbin/nologin'
  ) {
    throw new Error(`${accountLabel} account ${name} has unsafe passwd state`);
  }
  try {
    assertPasswdState?.(passwd, { uid, gid });
  } catch {
    throw new Error(`${accountLabel} account ${name} has unsafe passwd state`);
  }
  return { name, uid, gid };
}
