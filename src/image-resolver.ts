import type { WrapperConfig } from './types';
import { buildRuntimeImageRef, type ParsedImageTag } from './image-tag';

export type RuntimeImageName =
  | 'squid' | 'agent' | 'agent-act' | 'api-proxy' | 'cli-proxy' | 'build-tools'
  | 'enclave-script' | 'enclave-agent' | 'enclave-mcp-server' | 'dind-staging';

type ManifestKey = keyof NonNullable<WrapperConfig['images']>;

const MANIFEST_KEY: Record<RuntimeImageName, ManifestKey> = {
  squid: 'squid',
  agent: 'agent',
  'agent-act': 'agent',
  'api-proxy': 'apiProxy',
  'cli-proxy': 'cliProxy',
  'build-tools': 'buildTools',
  'enclave-script': 'enclaveScript',
  'enclave-agent': 'enclaveAgent',
  'enclave-mcp-server': 'enclaveMcpServer',
  'dind-staging': 'dindStaging',
};

const DIGEST_PINNED_IMAGE = /^[a-z0-9][a-z0-9._:-]*(?:\/[a-z0-9][a-z0-9._-]*)+:[A-Za-z0-9_][A-Za-z0-9_.-]*@sha256:[a-f0-9]{64}$/;

export function validateCustomImageManifest(config: WrapperConfig): void {
  const images = config.images;
  if (!images) return;

  for (const [role, reference] of Object.entries(images)) {
    if (!reference || !DIGEST_PINNED_IMAGE.test(reference) || /\s|\$|\{\{/.test(reference)) {
      throw new Error(`Invalid container.images.${role}: expected a literal tag@sha256:<64-hex> OCI reference`);
    }
  }

  const legacy = [
    config.sysrootImage && 'sysrootImage',
    config.buildLocal && 'buildLocal',
    config.dind?.stagingImage && 'dind.stagingImage',
    config.enclaves?.executors.script.image && 'enclaves.script.image',
    config.enclaves?.executors.agent.image && 'enclaves.agent.image',
  ].filter(Boolean);
  if (legacy.length > 0) {
    throw new Error(`container.images cannot be combined with legacy image settings: ${legacy.join(', ')}`);
  }
}

export function resolveRuntimeImage(
  config: WrapperConfig,
  imageName: RuntimeImageName,
  registry: string,
  parsedTag: ParsedImageTag,
): string {
  validateCustomImageManifest(config);
  if (config.images) {
    const image = config.images[MANIFEST_KEY[imageName]];
    if (!image) {
      throw new Error(`container.images must include "${MANIFEST_KEY[imageName]}" when ${imageName} is enabled`);
    }
    return image;
  }
  return buildRuntimeImageRef(registry, imageName === 'dind-staging' ? 'agent' : imageName, parsedTag);
}
