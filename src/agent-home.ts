import * as fs from 'fs';
import * as path from 'path';
import { runtimeUsesComposeAgent } from './container-runtime';
import { getRealUserHome } from './host-identity';
import { WrapperConfig } from './types';

type AgentHomeConfig = Pick<WrapperConfig, 'homeDir' | 'containerRuntime' | 'runnerTopology' | 'chrootIdentity'>;

function hasUnsafePathCharacters(value: string): boolean {
  return [':', '\r', '\n', '\0'].some(character => value.includes(character));
}

export function resolveAgentHome(config: AgentHomeConfig): string {
  if (config.homeDir === undefined) return getRealUserHome();
  if (!runtimeUsesComposeAgent(config.containerRuntime) || config.runnerTopology === 'arc-dind') {
    throw new Error('--home is supported only for Compose agents without ARC/DinD sysroot staging');
  }
  const home = config.homeDir;
  if (!path.isAbsolute(home) || hasUnsafePathCharacters(home)) {
    throw new Error('--home must be an absolute directory path without colons or control characters');
  }
  let resolved: string;
  try {
    resolved = fs.realpathSync(home);
    if (!fs.statSync(resolved).isDirectory()) throw new Error('not a directory');
    fs.accessSync(resolved, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
  } catch (error) {
    throw homePreparationError(home, error);
  }
  if (resolved === '/' || hasUnsafePathCharacters(resolved)) {
    throw new Error('--home must name a non-root directory without colons or control characters');
  }
  if (config.chrootIdentity?.home && config.chrootIdentity.home !== resolved) {
    throw new Error('--home must match chroot.identity.home when both are configured');
  }
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
