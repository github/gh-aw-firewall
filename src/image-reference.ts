// OCI reference grammar (distribution/reference) narrowed to literal
// references that carry an explicit registry host, a tag, and a sha256 digest.
const HOST_LABEL = '[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?';
const REGISTRY = `(?:${HOST_LABEL}(?:\\.${HOST_LABEL})+(?::[0-9]{1,5})?|${HOST_LABEL}:[0-9]{1,5}|localhost)`;
const PATH_COMPONENT = '[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*';
const TAG = '[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}';
const DIGEST = 'sha256:[a-f0-9]{64}';

const DIGEST_PINNED_IMAGE = new RegExp(
  `^${REGISTRY}/${PATH_COMPONENT}(?:/${PATH_COMPONENT})*:${TAG}@${DIGEST}$`,
);

export function isDigestPinnedImageReference(reference: string): boolean {
  if (/\s|\$|\{\{/.test(reference)) return false;
  return DIGEST_PINNED_IMAGE.test(reference);
}
