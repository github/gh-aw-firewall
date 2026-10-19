import * as path from 'path';
import type { WrapperConfig } from '../types';
import { PRIVATE_REPOSITORY_PATTERN } from '../bounded-execution';
import { HOST_EXECUTOR_DEFAULT_JOURNAL_DIRECTORY } from './host-executor-journal';

export const ENCLAVE_DEBUG_ARTIFACT_ROOT = path.join(
  path.dirname(HOST_EXECUTOR_DEFAULT_JOURNAL_DIRECTORY), 'debug-artifacts', 'cloud-hypervisor',
);
export const ENCLAVE_DEBUG_ARTIFACT_PROTECTED_ROOT =
  path.dirname(path.dirname(ENCLAVE_DEBUG_ARTIFACT_ROOT));

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

/** Default to retention only for the same scopes admitted by the explicit public-debug gate. */
export function resolvePublicEnclaveDebugConfig(config: WrapperConfig): WrapperConfig {
  if (!config.cloudHypervisor || config.cloudHypervisor.enclaveDebugPublic !== undefined) return config;
  const candidate: WrapperConfig = {
    ...config,
    cloudHypervisor: { ...config.cloudHypervisor, enclaveDebugPublic: true },
  };
  return validatePublicEnclaveDebug(candidate).length === 0 ? candidate : config;
}

const VISIBILITY_TRANSPORT_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

export class PublicDebugVisibilityError extends Error {
  constructor(reason: string, status?: number) {
    super(`Public enclave debug repository visibility could not be verified (reason=${reason}`
      + (status === undefined ? '' : `; status=${status}`) + ')');
  }
}

function visibilityTransportCode(error: unknown): string {
  if (!error || typeof error !== 'object') return 'unknown';
  const candidate = 'cause' in error && error.cause && typeof error.cause === 'object'
    ? error.cause : error;
  return 'code' in candidate && typeof candidate.code === 'string'
    && VISIBILITY_TRANSPORT_CODES.has(candidate.code) ? candidate.code : 'unknown';
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
    let phase = 'request-failed';
    let status: number | undefined;
    try {
      const response = await request(`https://api.github.com/repos/${repo}`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'awf-public-enclave-debug' },
        redirect: 'error',
        signal,
      });
      status = response.status;
      if (status !== 200) {
        phase = 'http-status';
        await response.body?.cancel();
        throw new PublicDebugVisibilityError('http-status', status);
      }
      if (!response.body) throw new PublicDebugVisibilityError('missing-body');
      phase = 'body-read';
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.length;
          if (size > 64 * 1024) throw new PublicDebugVisibilityError('metadata-bound');
          chunks.push(next.value);
        }
      } finally {
        await reader.cancel();
      }
      phase = 'invalid-json';
      const metadata: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (
        !metadata || typeof metadata !== 'object'
        || !('private' in metadata) || metadata.private !== false
        || !('visibility' in metadata) || metadata.visibility !== 'public'
        || !('full_name' in metadata) || typeof metadata.full_name !== 'string'
        || metadata.full_name.toLowerCase() !== repo.toLowerCase()
      ) {
        throw new PublicDebugVisibilityError('unverified-metadata');
      }
    } catch (error) {
      if (error instanceof PublicDebugVisibilityError) throw error;
      const timeout = signal.aborted || (error && typeof error === 'object'
        && 'name' in error && error.name === 'TimeoutError');
      throw new PublicDebugVisibilityError(
        `${timeout ? 'timeout' : phase}; code=${visibilityTransportCode(error)}`,
        status,
      );
    }
  }
}
