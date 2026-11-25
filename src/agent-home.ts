import * as fs from 'fs';
import * as path from 'path';
import { runtimeUsesComposeAgent } from './container-runtime';
import { CREDENTIAL_ENTRIES, HOME_FORBIDDEN_SUBDIRS } from './config/mount-policy';
import { getRealUserHome } from './host-identity';
import { WrapperConfig } from './types';

type AgentHomeConfig = Pick<WrapperConfig, 'homeDir' | 'containerRuntime' | 'runnerTopology' | 'chrootIdentity'>;

function hasUnsafePathCharacters(value: string): boolean {
  return [':', '\r', '\n', '\0'].some(character => value.includes(character));
}

function rejectUnmaskableCredentialDirectories(home: string): void {
  const unmaskable = new Set([
    ...HOME_FORBIDDEN_SUBDIRS,
    ...CREDENTIAL_ENTRIES.filter((entry) => entry.type === 'dir' && !entry.files?.length)
      .map((entry) => entry.path),
  ]);
  for (const relative of unmaskable) {
    const credentialPath = path.join(home, relative);
    try {
      fs.lstatSync(credentialPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw homePreparationError(credentialPath, error);
    }
    throw new Error(
      `Refusing to use --home containing an unmaskable credential directory: ${credentialPath}. ` +
      'Use a fresh job-scoped directory without existing credentials.',
    );
  }
}

export function resolveAgentHome(config: AgentHomeConfig, env: NodeJS.ProcessEnv = process.env): string {
  if (config.homeDir === undefined) return getRealUserHome();
  if (!runtimeUsesComposeAgent(config.containerRuntime) || config.runnerTopology === 'arc-dind') {
    throw new Error('--home is supported only for Compose agents without ARC/DinD sysroot staging');
  }
  const home = config.homeDir;
  if (!path.isAbsolute(home) || hasUnsafePathCharacters(home)) {
    throw new Error('--home must be an absolute directory path without colons or control characters');
  }
  let resolved: string;
  let homeStat: fs.Stats;
  try {
    resolved = fs.realpathSync(home);
    homeStat = fs.statSync(resolved);
    if (!homeStat.isDirectory()) throw new Error('not a directory');
    fs.accessSync(resolved, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
  } catch (error) {
    throw homePreparationError(home, error);
  }
  if (resolved === '/' || hasUnsafePathCharacters(resolved)) {
    throw new Error('--home must name a non-root directory without colons or control characters');
  }
  const effectiveUid = process.getuid?.();
  const sudoUid = env.SUDO_UID !== undefined
    ? Number.parseInt(env.SUDO_UID, 10)
    : undefined;
  const trustedOwners = new Set<number>();
  if (effectiveUid !== undefined) trustedOwners.add(effectiveUid);
  if (effectiveUid === 0 && sudoUid !== undefined && Number.isSafeInteger(sudoUid) && sudoUid >= 0) {
    trustedOwners.add(sudoUid);
  }
  if (!trustedOwners.has(homeStat.uid)) {
    throw new Error(
      `Refusing to use --home not owned by the invoking user: ${resolved} ` +
      `(owner uid=${homeStat.uid}, trusted uid(s)=${[...trustedOwners].join(',')})`,
    );
  }
  if ((homeStat.mode & 0o022) !== 0) {
    throw new Error(
      `Refusing to use --home writable by group or other users: ${resolved} ` +
      `(mode=${(homeStat.mode & 0o777).toString(8)})`,
    );
  }
  if (config.chrootIdentity?.home && config.chrootIdentity.home !== resolved) {
    throw new Error('--home must match chroot.identity.home when both are configured');
  }
  rejectUnmaskableCredentialDirectories(resolved);
  return resolved;
}

export function homePreparationError(home: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(
    `Cannot prepare agent home or credential mount path ${home}: ${detail}. ` +
    'NFS root-squash can prevent root from creating or owning mountpoints. ' +
    'Create a job-scoped directory on local disk as the runner user and pass --home <path>. ' +
    'Credential protections must not be disabled.',
  );
}
