import { promises as fs } from 'fs';
import { assertTrustedHostTool, calculateSha256 } from './artifact-trust';
import { logger } from '../logger';

export const DEVELOPMENT_ENCLAVE_SUPERVISOR_PATH =
  '/var/lib/awf-enclave-smoke-export/awf-supervisor-development';

export interface DevelopmentEnclaveSupervisor {
  readonly path: string;
  readonly sha256: string;
}

export async function resolveDevelopmentEnclaveSupervisor(
  environment: NodeJS.ProcessEnv,
  publicDebugVerified: boolean,
  dependencies = { assertTrustedHostTool, calculateSha256, realpath: fs.realpath },
): Promise<DevelopmentEnclaveSupervisor | undefined> {
  const sha256 = environment.AWF_CH_ENCLAVE_TEST_SUPERVISOR_SHA256;
  if (sha256 === undefined) return undefined;
  const ref = 'refs/heads/lpcox-smoke-pins-v0-28-64';
  const workflow = 'github/gh-aw-firewall/.github/workflows/smoke-enclave-cloud-hypervisor-copilot.lock.yml';
  if (!publicDebugVerified ||
    environment.GITHUB_ACTIONS !== 'true' ||
    environment.GITHUB_REPOSITORY !== 'github/gh-aw-firewall' ||
    environment.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    environment.GITHUB_REF_TYPE !== 'branch' ||
    environment.GITHUB_REF !== ref ||
    environment.GITHUB_REF_NAME !== 'lpcox-smoke-pins-v0-28-64' ||
    !/^[a-f0-9]{40}$/.test(environment.GITHUB_SHA ?? '') ||
    environment.GITHUB_WORKFLOW_SHA !== environment.GITHUB_SHA ||
    environment.GITHUB_WORKFLOW_REF !== `${workflow}@${ref}` ||
    !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error('Unattested enclave supervisor is restricted to the verified public PR smoke');
  }
  const file = DEVELOPMENT_ENCLAVE_SUPERVISOR_PATH;
  if (await dependencies.realpath(file) !== file) {
    throw new Error('Development enclave supervisor must use its canonical host-only path');
  }
  await dependencies.assertTrustedHostTool('development enclave supervisor', file);
  if (await dependencies.calculateSha256(file) !== sha256) {
    throw new Error('Development enclave supervisor checksum mismatch');
  }
  logger.warn(`UNATTESTED DEVELOPMENT enclave supervisor: commit=${environment.GITHUB_SHA} sha256=${sha256}`);
  return Object.freeze({ path: file, sha256 });
}
