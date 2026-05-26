import { WrapperConfig } from '../../types';
import { shouldUseDockerHostStaging, stageHostFile } from './docker-host-staging';

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

  const stagedPasswdPath = stageHostFile(config, '/etc/passwd', 'etc/passwd');
  const stagedGroupPath = stageHostFile(config, '/etc/group', 'etc/group');
  mounts.push(`${stagedPasswdPath || '/etc/passwd'}:/host/etc/passwd:ro`);
  mounts.push(`${stagedGroupPath || '/etc/group'}:/host/etc/group:ro`);

  return mounts;
}
