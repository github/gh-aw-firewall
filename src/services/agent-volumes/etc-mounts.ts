import * as fs from 'fs';
import * as path from 'path';
import { WrapperConfig } from '../../types';
import { shouldUseDockerHostStaging, stageHostFile, getDockerHostStageRoot } from './docker-host-staging';
import { getSafeHostUid, getSafeHostGid } from '../../host-identity';
import { isSysrootEnabled } from '../sysroot-service';
import { etcAllowlist } from '../../config/mount-policy';

const OPTIONAL_ETC_CA_MOUNTS = new Set<string>([
  '/etc/pki/ca-trust/extracted',
  '/etc/pki/tls/certs',
]);

function normalizeDockerHostPathPrefix(prefix: string): string {
  const trimmed = prefix.trim();
  if (!trimmed) return '';
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+$/, '') || '/';
}

function bindMountSourceExists(hostPath: string, config: WrapperConfig): boolean {
  if (fs.existsSync(hostPath)) {
    return true;
  }

  if (!config.dockerHostPathPrefix) {
    return false;
  }

  const normalizedPrefix = normalizeDockerHostPathPrefix(config.dockerHostPathPrefix);
  if (!normalizedPrefix || normalizedPrefix === '/') {
    return false;
  }

  return fs.existsSync(`${normalizedPrefix}${hostPath}`);
}

/**
 * Synthesize a minimal /etc/passwd or /etc/group file in the staging directory.
 * Used when the runner doesn't have these files (e.g., minimal ARC-DinD containers).
 */
function synthesizeIdentityFile(config: WrapperConfig, relPath: string, content: string): string | undefined {
  try {
    const stageRoot = getDockerHostStageRoot(config);
    const tempDir = path.join(stageRoot, 'identity');
    fs.mkdirSync(tempDir, { recursive: true });
    const targetPath = path.join(tempDir, path.basename(relPath));
    fs.writeFileSync(targetPath, content, { mode: 0o644 });
    return targetPath;
  } catch {
    return undefined;
  }
}

function readFileContent(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

function fileHasPasswdUid(content: string, uid: string): boolean {
  return new RegExp(`^[^:]*:[^:]*:${uid}:`, 'm').test(content);
}

function fileHasGroupGid(content: string, gid: string): boolean {
  return new RegExp(`^[^:]*:[^:]*:${gid}:`, 'm').test(content);
}

function withTrailingNewline(content: string): string {
  return content.endsWith('\n') ? content : `${content}\n`;
}
function hasEntryWithName(content: string, name: string): boolean {
  return new RegExp(`^${name}:`, 'm').test(content);
}

function resolveUniqueName(content: string, preferredName: string, id: string): string {
  const baseName = hasEntryWithName(content, preferredName) ? `${preferredName}-${id}` : preferredName;
  if (!hasEntryWithName(content, baseName)) {
    return baseName;
  }

  let counter = 1;
  while (hasEntryWithName(content, `${baseName}-${counter}`)) {
    counter += 1;
  }
  return `${baseName}-${counter}`;
}

export function buildEtcMounts(config: WrapperConfig): string[] {
  // When sysroot-stage is active (arc-dind), the sysroot volume already provides
  // a complete /etc from the build-tools image. Bind-mounting the host's /etc files
  // on top would fail on split-fs (Docker daemon can't resolve runner paths).
  if (isSysrootEnabled(config)) {
    return [];
  }

  const mounts: string[] = etcAllowlist()
    .filter((p) => !OPTIONAL_ETC_CA_MOUNTS.has(p) || bindMountSourceExists(p, config))
    .map((p) => `${p}:/host${p}:ro`);

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
  const passwdEntry = `runner:x:${uid}:${gid}:GitHub Actions Runner:/home/runner:/bin/bash`;
  if (!passwdPath) {
    const minimalPasswd = [
      'root:x:0:0:root:/root:/bin/bash',
      'nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin',
      passwdEntry,
    ].join('\n') + '\n';
    passwdPath = synthesizeIdentityFile(config, 'etc/passwd', minimalPasswd);
  } else {
    const stagedPasswdContent = readFileContent(passwdPath);
    if (stagedPasswdContent && !fileHasPasswdUid(stagedPasswdContent, uid)) {
      const passwdUser = resolveUniqueName(stagedPasswdContent, 'runner', uid);
      const userPasswdEntry = `${passwdUser}:x:${uid}:${gid}:GitHub Actions Runner:/home/${passwdUser}:/bin/bash`;
      passwdPath = synthesizeIdentityFile(
        config,
        'etc/passwd',
        `${withTrailingNewline(stagedPasswdContent)}${userPasswdEntry}\n`
      ) || passwdPath;
    }
  }

  let groupPath = stageHostFile(config, '/etc/group', 'etc/group');
  const groupEntry = `runner:x:${gid}:`;
  if (!groupPath) {
    const minimalGroup = [
      'root:x:0:',
      'nobody:x:65534:',
      groupEntry,
    ].join('\n') + '\n';
    groupPath = synthesizeIdentityFile(config, 'etc/group', minimalGroup);
  } else {
    const stagedGroupContent = readFileContent(groupPath);
    if (stagedGroupContent && !fileHasGroupGid(stagedGroupContent, gid)) {
      const groupName = resolveUniqueName(stagedGroupContent, 'runner', gid);
      const userGroupEntry = `${groupName}:x:${gid}:`;
      groupPath = synthesizeIdentityFile(config, 'etc/group', `${withTrailingNewline(stagedGroupContent)}${userGroupEntry}\n`) || groupPath;
    }
  }

  mounts.push(`${passwdPath || '/etc/passwd'}:/host/etc/passwd:ro`);
  mounts.push(`${groupPath || '/etc/group'}:/host/etc/group:ro`);

  return mounts;
}
