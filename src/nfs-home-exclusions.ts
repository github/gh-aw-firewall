import * as fs from 'fs';
import * as path from 'path';
import { CREDENTIAL_ENTRIES, HOME_FORBIDDEN_SUBDIRS, credentialFilesToHide, gitLabCredentialFiles } from './config/mount-policy';
import { isVanishedSource } from './nfs-home-copy';
import { WrapperConfig } from './types';

export function buildNfsHomeExclusions(config: WrapperConfig, home: string): string[] {
  const excluded = [
    ...CREDENTIAL_ENTRIES.map((entry) => path.join(home, entry.path)),
    ...credentialFilesToHide().map((entry) => path.join(home, entry)),
    ...HOME_FORBIDDEN_SUBDIRS.map((entry) => path.join(home, entry)),
    ...gitLabCredentialFiles(home, process.env),
    ...(config.enableApiProxy && config.envFile ? [path.resolve(config.envFile)] : []),
    path.join(home, '.copilot/session-state'),
    path.join(home, '.copilot/logs'),
  ];
  // A credential store may itself be a symlink into an allowlisted cache.
  for (const entry of [...excluded]) {
    try {
      excluded.push(fs.realpathSync(entry));
    } catch (error) {
      if (!isVanishedSource(error)) throw error;
    }
  }
  return excluded;
}
