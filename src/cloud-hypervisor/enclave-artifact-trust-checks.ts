import { constants, promises as fs } from 'fs';
import * as path from 'path';
import {
  assertTrustedHostTool,
  assertTrustedRegularFile,
  calculateSha256,
  resolveTrustedOperatorUid,
} from './artifact-trust';
import type { CloudHypervisorEnclaveArtifactPreflightOptions } from './enclave-executor-types';
import {
  HostPreflightReporter, markHostPreflightError, type HostPreflightCheck,
} from './host-preflight-progress';

export function checkEnclaveArtifact<T>(
  report: HostPreflightReporter | undefined,
  id: HostPreflightCheck,
  operation: () => Promise<T> | T,
): Promise<T> {
  return report ? report.check(id, operation) : Promise.resolve().then(operation);
}

export function enclaveArtifactPath(directory: string, name: string): string {
  const result = path.join(directory, name);
  if (path.dirname(result) !== directory) throw new Error('Invalid enclave artifact path');
  return result;
}

export async function checkEnclaveArtifactTrust(
  options: CloudHypervisorEnclaveArtifactPreflightOptions,
  report?: HostPreflightReporter,
): Promise<{ uid: number; manifestDir: string }> {
  const uid = await checkEnclaveArtifact(report, 'operator-identity', resolveTrustedOperatorUid);
  await checkEnclaveArtifact(report, 'tool-gh', () => assertTrustedHostTool('GitHub CLI', options.attestationToolPath));
  const manifestDir = path.dirname(options.manifestPath);
  const expectedBundle = enclaveArtifactPath(manifestDir, 'cloud-hypervisor-enclave-rootfs-x86_64.manifest.sigstore.jsonl');
  await checkEnclaveArtifact(report, 'manifest-bundle-path', () => {
    if (options.manifestBundlePath !== expectedBundle) {
      throw markHostPreflightError(new Error('Enclave artifact manifest bundle must use its fixed release filename'),
        'requirement-not-met');
    }
  });
  await checkEnclaveArtifact(report, 'manifest-trust', () => assertTrustedRegularFile('enclave artifact manifest', options.manifestPath, constants.R_OK, {
    uid, access: fs.access, lstat: fs.lstat, sha256: calculateSha256,
  }));
  await checkEnclaveArtifact(report, 'bundle-trust', () => assertTrustedRegularFile('enclave artifact manifest bundle', options.manifestBundlePath, constants.R_OK, {
    uid, access: fs.access, lstat: fs.lstat, sha256: calculateSha256,
  }));
  return { uid, manifestDir };
}

export async function resolveTrustedAttestationTool(environment: NodeJS.ProcessEnv): Promise<string> {
  let lastError: unknown;
  for (const directory of (environment.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, 'gh');
    try {
      await assertTrustedHostTool('GitHub CLI', candidate);
      return candidate;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `A trusted GitHub CLI is required to verify enclave artifact attestations: ${
      lastError instanceof Error ? lastError.message : String(lastError ?? 'not found')
    }`,
  );
}
