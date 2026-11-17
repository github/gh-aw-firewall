import { buildRuntimeImageRef } from '../image-tag';
import type { EnclaveScriptExecutorConfig } from '../types/enclave-options';
import type { EnclaveMcpBuildResult } from './enclave-mcp-service';
import { buildContainerSecurityHardening } from './service-security';
import type { ImageBuildConfig } from './squid-service';

export const LOCAL_ENCLAVE_SCRIPT_IMAGE = 'awf-enclave-script:local';
export const ENCLAVE_SCRIPT_IMAGE_NAME = 'enclave-script';

export function resolveScriptImage(
  imageConfig: ImageBuildConfig,
  override?: string,
): { imageRef: string; source: Record<string, unknown> } {
  if (override) return { imageRef: override, source: { image: override } };
  if (imageConfig.useGHCR) {
    const imageRef = imageConfig.resolveImage?.(ENCLAVE_SCRIPT_IMAGE_NAME) ??
      buildRuntimeImageRef(imageConfig.registry, ENCLAVE_SCRIPT_IMAGE_NAME, imageConfig.parsedTag);
    return { imageRef, source: { image: imageRef } };
  }
  return {
    imageRef: LOCAL_ENCLAVE_SCRIPT_IMAGE,
    source: {
      image: LOCAL_ENCLAVE_SCRIPT_IMAGE,
      build: {
        context: `${imageConfig.projectRoot}/containers`,
        dockerfile: 'enclave/Dockerfile',
        target: 'enclave-script',
      },
    },
  };
}

export function buildEnclaveMcpScriptService(params: {
  script: EnclaveScriptExecutorConfig;
  imageConfig: ImageBuildConfig;
  environment: Record<string, string>;
  dependsOn: Record<string, Record<string, string>>;
  result: EnclaveMcpBuildResult;
}): void {
  const { script, imageConfig, environment, dependsOn, result } = params;
  if (script.runtime !== 'cloud-hypervisor') {
    const { imageRef, source } = resolveScriptImage(imageConfig, script.image);
    result.scriptImageService = {
      ...source,
      network_mode: 'none',
      entrypoint: ['/bin/true'],
      ...buildContainerSecurityHardening({ memLimit: '32m', pidsLimit: 16, cpuShares: 64 }),
      restart: 'no',
    };
    dependsOn['enclave-script-image'] = { condition: 'service_completed_successfully' };
    environment.AWF_ENCLAVE_IMAGE = imageRef;
  }
  Object.assign(environment, {
    ...(script.runtime !== 'gvisor' && { AWF_ENCLAVE_ENTRY_ID: 'script' }),
    AWF_ENCLAVE_BACKEND: script.runtime,
    AWF_ENCLAVE_TIMEOUT: String(script.timeout),
    AWF_ENCLAVE_MEMORY: script.memoryLimit,
    AWF_ENCLAVE_CPU: script.cpuLimit,
    AWF_ENCLAVE_PIDS: String(script.pidsLimit),
    AWF_ENCLAVE_TMPFS: script.tmpfsLimit,
    AWF_ENCLAVE_MAX_OUTPUT_BYTES: String(script.maxOutputBytes),
    AWF_ENCLAVE_MAX_SCRIPT_BYTES: String(script.maxScriptBytes),
    AWF_ENCLAVE_MAX_INVOCATIONS: String(script.maxInvocations),
  });
}
