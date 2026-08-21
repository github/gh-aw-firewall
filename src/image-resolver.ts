import type { WrapperConfig } from './types';
import { buildRuntimeImageRef, parseImageTag, type ParsedImageTag } from './image-tag';

export type RuntimeImageName =
  | 'squid' | 'agent' | 'agent-act' | 'api-proxy' | 'cli-proxy' | 'build-tools'
  | 'enclave-script' | 'enclave-agent' | 'enclave-mcp-server' | 'dind-staging' | 'doh-proxy';

type ManifestKey = keyof NonNullable<WrapperConfig['images']>;

/**
 * Subset of the wrapper configuration required to resolve infrastructure
 * images. Declared structurally so consumers that run outside Docker Compose
 * (pre-download, DinD bootstrap, rootless artifact repair) can resolve
 * manifest images without carrying a full `WrapperConfig`.
 */
export type ImageManifestConfig = Pick<
  WrapperConfig,
  'images' | 'imageRegistry' | 'imageTag' | 'agentImage' | 'buildLocal' | 'sslBump' |
  'sysrootImage' | 'dind' | 'enclaves'
>;

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
  'doh-proxy': 'dohProxy',
};

export const DEFAULT_IMAGE_REGISTRY = 'ghcr.io/github/gh-aw-firewall';
export const DEFAULT_DIND_STAGING_IMAGE = 'ghcr.io/github/gh-aw-firewall/agent:latest';
export const DEFAULT_DOH_PROXY_IMAGE = 'cloudflare/cloudflared:latest';

/**
 * Roles whose default (non-manifest) image is not published under the AWF
 * registry and therefore cannot be derived from registry/tag inputs.
 */
const EXTERNAL_DEFAULT_IMAGE: Partial<Record<RuntimeImageName, string>> = {
  'doh-proxy': DEFAULT_DOH_PROXY_IMAGE,
  'dind-staging': DEFAULT_DIND_STAGING_IMAGE,
};

// OCI reference grammar (distribution/reference) narrowed to literal
// references that carry an explicit registry host, a tag, and a sha256 digest.
const HOST_LABEL = '[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?';
const REGISTRY = `(?:${HOST_LABEL}(?:\\.${HOST_LABEL})+(?::[0-9]{1,5})?|${HOST_LABEL}:[0-9]{1,5}|localhost)`;
const PATH_COMPONENT = '[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*';
const TAG = '[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}';
const DIGEST = 'sha256:[a-f0-9]{64}';

/**
 * Canonical pattern for a compiler-authorized image reference. Kept in sync
 * with `$defs/digestPinnedImage` in the AWF configuration JSON Schema.
 */
export const DIGEST_PINNED_IMAGE_PATTERN =
  `^${REGISTRY}/${PATH_COMPONENT}(?:/${PATH_COMPONENT})*:${TAG}@${DIGEST}$`;

const DIGEST_PINNED_IMAGE = new RegExp(DIGEST_PINNED_IMAGE_PATTERN);

export function isDigestPinnedImageReference(reference: string): boolean {
  if (/\s|\$|\{\{/.test(reference)) return false;
  return DIGEST_PINNED_IMAGE.test(reference);
}

export interface ResolvedRuntimeImage {
  image: string;
  source: 'explicit' | 'default';
}

// Central ledger of every infrastructure image this process resolved, including
// consumers that never appear in the generated Compose file (DinD staging,
// pre-download, rootless artifact repair). Audit artifacts are written from it.
const resolvedImages = new Map<RuntimeImageName, ResolvedRuntimeImage>();

export function recordRuntimeImage(
  imageName: RuntimeImageName,
  image: string,
  source: ResolvedRuntimeImage['source'],
): string {
  resolvedImages.set(imageName, { image, source });
  return image;
}

/** @internal Exposed so tests can isolate the process-wide resolution ledger. */
// ts-prune-ignore-next
export function resetRuntimeImageLedger(): void {
  resolvedImages.clear();
}

export function validateCustomImageManifest(config: ImageManifestConfig): void {
  const images = config.images;
  if (!images) return;

  for (const [role, reference] of Object.entries(images)) {
    if (!reference || !isDigestPinnedImageReference(reference)) {
      throw new Error(
        `Invalid container.images.${role}: expected a literal registry-qualified ` +
        'tag@sha256:<64-hex> OCI reference',
      );
    }
  }

  // Any control that could select an image other than the manifest entry is
  // ambiguous, so it is rejected rather than silently ignored.
  const conflicts = [
    config.sysrootImage && 'sysrootImage',
    config.buildLocal && 'buildLocal',
    config.sslBump && 'sslBump (requires a locally built Squid image)',
    config.agentImage && config.agentImage !== 'default' && 'agentImage',
    config.dind?.stagingImage && 'dind.stagingImage',
    config.enclaves?.executors.script.image && 'enclaves.script.image',
    config.enclaves?.executors.agent.image && 'enclaves.agent.image',
  ].filter(Boolean);
  if (conflicts.length > 0) {
    throw new Error(`container.images cannot be combined with legacy image settings: ${conflicts.join(', ')}`);
  }
}

export function resolveRuntimeImage(
  config: ImageManifestConfig,
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
    return recordRuntimeImage(imageName, image, 'explicit');
  }
  const externalDefault = EXTERNAL_DEFAULT_IMAGE[imageName];
  if (externalDefault) {
    return recordRuntimeImage(imageName, externalDefault, 'default');
  }
  return recordRuntimeImage(imageName, buildRuntimeImageRef(registry, imageName, parsedTag), 'default');
}

/**
 * Resolves an image for a consumer that only carries manifest-relevant
 * configuration (no Compose image-build context).
 */
export function resolveRuntimeImageFor(
  config: ImageManifestConfig,
  imageName: RuntimeImageName,
): string {
  return resolveRuntimeImage(
    config,
    imageName,
    config.imageRegistry || DEFAULT_IMAGE_REGISTRY,
    parseImageTag(config.imageTag || 'latest'),
  );
}

/**
 * Image used by the DinD bootstrap helper containers. This consumer runs
 * outside Docker Compose, so it resolves (and records) its own image.
 */
export function resolveDindStagingImage(config: ImageManifestConfig): string {
  if (config.images) return resolveRuntimeImageFor(config, 'dind-staging');
  return recordRuntimeImage(
    'dind-staging',
    config.dind?.stagingImage || DEFAULT_DIND_STAGING_IMAGE,
    'default',
  );
}

/**
 * Image used by the DNS-over-HTTPS sidecar. Upstream `cloudflared:latest` is
 * only used when no compiler-authorized manifest is configured.
 */
export function resolveDohProxyImage(config: ImageManifestConfig): string {
  return resolveRuntimeImageFor(config, 'doh-proxy');
}

/** Manifest role backing the configured agent image preset. */
export function agentImageRole(agentImage?: string): RuntimeImageName {
  return agentImage === 'act' ? 'agent-act' : 'agent';
}

/**
 * Snapshot of every image this run resolved, keyed by manifest role. Consumers
 * that resolve lazily (DinD bootstrap) are resolved eagerly here so the audit
 * record stays complete even before their container starts.
 */
export function collectResolvedRuntimeImages(
  config: ImageManifestConfig,
): Record<string, ResolvedRuntimeImage> {
  if (config.dind?.preStageDirs || config.dind?.stageEngineBinary) {
    resolveDindStagingImage(config);
  }
  return Object.fromEntries(
    [...resolvedImages.entries()].map(([role, resolved]) => [MANIFEST_KEY[role], resolved]),
  );
}
