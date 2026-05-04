export const IMAGE_DIGEST_KEYS = ['squid', 'agent', 'agent-act', 'api-proxy', 'cli-proxy'] as const;

export type ImageDigestKey = typeof IMAGE_DIGEST_KEYS[number];

export interface ParsedImageTag {
  tag: string;
  digests: Partial<Record<ImageDigestKey, string>>;
}

/**
 * Parse image-tag values in either of these formats:
 * - legacy: "0.25.18"
 * - digest-aware: "0.25.18,squid=sha256:...,agent=sha256:...,api-proxy=sha256:..."
 */
export function parseImageTag(imageTag: string): ParsedImageTag {
  const raw = imageTag.trim();
  if (!raw) {
    throw new Error('Invalid --image-tag value: tag cannot be empty');
  }

  const [rawTag, ...rawDigestEntries] = raw.split(',');
  const tag = rawTag.trim();
  if (!tag) {
    throw new Error('Invalid --image-tag value: tag cannot be empty');
  }

  const digests: Partial<Record<ImageDigestKey, string>> = {};
  const validKeys = new Set<string>(IMAGE_DIGEST_KEYS);

  for (const entry of rawDigestEntries) {
    const trimmedEntry = entry.trim();
    if (!trimmedEntry) {
      continue;
    }

    const equalIndex = trimmedEntry.indexOf('=');
    if (equalIndex <= 0 || equalIndex === trimmedEntry.length - 1) {
      throw new Error(
        `Invalid --image-tag digest entry "${trimmedEntry}". Expected format: <image>=sha256:<64-hex>`
      );
    }

    const key = trimmedEntry.slice(0, equalIndex).trim();
    const digest = trimmedEntry.slice(equalIndex + 1).trim();

    if (!validKeys.has(key)) {
      throw new Error(
        `Invalid --image-tag digest key "${key}". Supported keys: ${IMAGE_DIGEST_KEYS.join(', ')}`
      );
    }

    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
      throw new Error(
        `Invalid --image-tag digest "${digest}" for "${key}". Expected lowercase sha256:<64-hex>`
      );
    }

    digests[key as ImageDigestKey] = digest;
  }

  return { tag, digests };
}

export function buildRuntimeImageRef(
  imageRegistry: string,
  imageName: string,
  parsedTag: ParsedImageTag
): string {
  if (!IMAGE_DIGEST_KEYS.includes(imageName as ImageDigestKey)) {
    throw new Error(
      `Invalid runtime image name "${imageName}". Supported names: ${IMAGE_DIGEST_KEYS.join(', ')}`
    );
  }

  const digest = parsedTag.digests[imageName as ImageDigestKey];
  return `${imageRegistry}/${imageName}:${parsedTag.tag}${digest ? `@${digest}` : ''}`;
}
