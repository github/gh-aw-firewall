import * as fs from 'fs';
import * as path from 'path';
import { WrapperConfig } from '../../types';
import { shouldUseDockerHostStaging, stageHostFile, getDockerHostStageRoot } from './docker-host-staging';
import { getSafeHostUid, getSafeHostGid } from '../../host-identity';

/**
 * Synthesize a minimal /etc/passwd or /etc/group file in the staging directory.
 * Used when the runner doesn't have these files (e.g., minimal ARC-DinD containers).
 */
function synthesizeIdentityFile(config: WrapperConfig, relPath: string, content: string): string | undefined {
  try {
    const stageRoot = getDockerHostStageRoot(config);
    const targetPath = path.resolve(stageRoot, relPath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content, { mode: 0o644 });
    return targetPath;
  } catch {
    return undefined;
  }
}

export function buildEtcMounts(config: WrapperConfig): string[] {
  const mounts: string[] = [
    '/etc/ssl:/host/etc/ssl:ro',
    '/etc/ca-certificates:/host/etc/ca-certificates:ro',
    '/etc/alternatives:/host/etc/alternatives:ro',
    '/etc/ld.so.cache:/host/etc/ld.so.cache:ro',
    '/etc/nsswitch.conf:/host/etc/nsswitch.conf:ro',
  ];

  if (!shouldUseDockerHostStaging(config.dockerHostPathPrefix)) {
    mounts.push('/etc/passwd:/host/etc/passwd:ro');
    mounts.push('/etc/group:/host/etc/group:ro');
    return mounts;
  }

  // In DinD mode, stage /etc/passwd and /etc/group from the runner.
  // If the runner doesn't have these files (minimal ARC containers), synthesize minimal ones.
  const uid = getSafeHostUid();
  const gid = getSafeHostGid();

  let passwdPath = stageHostFile(config, '/etc/passwd', 'etc/passwd');
  if (!passwdPath) {
    const minimalPasswd = [
      'root:x:0:0:root:/root:/bin/bash',
      'nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin',
      `runner:x:${uid}:${gid}:GitHub Actions Runner:/home/runner:/bin/bash`,
    ].join('\n') + '\n';
    passwdPath = synthesizeIdentityFile(config, 'etc/passwd', minimalPasswd);
  }

  let groupPath = stageHostFile(config, '/etc/group', 'etc/group');
  if (!groupPath) {
    const minimalGroup = [
      'root:x:0:',
      'nobody:x:65534:',
      `runner:x:${gid}:`,
    ].join('\n') + '\n';
    groupPath = synthesizeIdentityFile(config, 'etc/group', minimalGroup);
  }

  mounts.push(`${passwdPath || '/etc/passwd'}:/host/etc/passwd:ro`);
  mounts.push(`${groupPath || '/etc/group'}:/host/etc/group:ro`);

  return mounts;
}
