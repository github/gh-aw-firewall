import * as path from 'path';
import type { WrapperConfig } from '../types';
import { PRIVATE_REPOSITORY_PATTERN } from '../bounded-execution';
import { HOST_EXECUTOR_DEFAULT_JOURNAL_DIRECTORY } from './host-executor-journal';

export const ENCLAVE_DEBUG_ARTIFACT_ROOT = path.join(
  path.dirname(HOST_EXECUTOR_DEFAULT_JOURNAL_DIRECTORY), 'debug-artifacts', 'cloud-hypervisor',
);

export function validatePublicEnclaveDebug(config: WrapperConfig): string[] {
  if (!config.cloudHypervisor?.enclaveDebugPublic) return [];
  const enclaves = config.enclaves;
  if (
    !config.cloudHypervisor.previewEnabled
    || config.cloudHypervisor.developmentAllowUnattestedArtifacts
    || config.cloudHypervisor.sha256 !== undefined
    || !enclaves?.enabled
    || enclaves.executors.agent.dynamic !== undefined
    || enclaves.privateRepos.length === 0
    || enclaves.privateRepos.some(({ repo, sensitivity }) =>
      sensitivity !== 'public' || !PRIVATE_REPOSITORY_PATTERN.test(repo))
    || !Object.values(enclaves.executors).some((entry) => entry.enabled)
    || Object.values(enclaves.executors).some((entry) =>
      entry.enabled && (entry.runtime !== 'cloud-hypervisor' || entry.image !== undefined))
  ) {
    return ['Cloud Hypervisor enclave debug requires attested, static public-only fixtures and Cloud Hypervisor executors; dynamic, private, custom-image and development scopes are unsupported'];
  }
  return [];
}

/**
 * Sensitivity is a disclosure policy, not proof of public visibility. Verify
 * without credentials or redirects before any debug-enabled VM can launch.
 */
export async function verifyPublicEnclaveDebugRepositories(
  config: WrapperConfig,
  request: typeof fetch = fetch,
): Promise<void> {
  if (!config.cloudHypervisor?.enclaveDebugPublic) return;
  const errors = validatePublicEnclaveDebug(config);
  if (errors.length) throw new Error(errors.join('; '));
  for (const { repo } of config.enclaves!.privateRepos) {
    const signal = AbortSignal.timeout(5_000);
    const response = await request(`https://api.github.com/repos/${repo}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'awf-public-enclave-debug' },
      redirect: 'error',
      signal,
    });
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw new Error('Public enclave debug repository visibility could not be verified');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > 64 * 1024) throw new Error('Public enclave debug repository metadata exceeds its bound');
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel();
    }
    const metadata: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (
      !metadata || typeof metadata !== 'object'
      || !('private' in metadata) || metadata.private !== false
      || !('visibility' in metadata) || metadata.visibility !== 'public'
      || !('full_name' in metadata) || typeof metadata.full_name !== 'string'
      || metadata.full_name.toLowerCase() !== repo.toLowerCase()
    ) {
      throw new Error('Public enclave debug requires positively verified public repository visibility');
    }
  }
}
