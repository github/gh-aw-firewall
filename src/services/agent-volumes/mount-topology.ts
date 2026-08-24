/**
 * Shared helpers for reasoning about the *final* compose bind topology.
 *
 * Both the credential-overlay prune and the nested-mountpoint preparation need
 * to answer the same two questions about a generated volume list:
 *
 *  1. Which bind covers a given container path once runc has mounted parents
 *     first (the innermost strictly-shallower bind)?
 *  2. Where does that bind's source live *on the runner*, so we can probe or
 *     prepare it before `docker compose up`?
 *
 * Question 2 is subtle on split-filesystem runners (`--docker-host-path-prefix`).
 * Custom volume mounts are materialised with daemon-side sources, so a runner
 * local `fs` call against them is meaningless. Everything else is still a
 * runner-local path at this stage because the prefix is applied last.
 *
 * Being *under* the prefix is therefore not the same as being daemon-only. A
 * shared prefix (see `isSharedDockerHostPathPrefix`) names one filesystem both
 * sides can see at the same path, and the run's own workDir lives inside it —
 * treating that as unresolvable would make the whole run directory
 * unclassifiable. The mirror-image mistake is just as bad: a daemon-only
 * prefix that merely looks shared (`/tmp/gh-aw`) must keep failing closed.
 */

import { isSharedDockerHostPathPrefix, normalizeDockerHostPathPrefix } from '../host-path-prefix';

export interface ParsedMount {
  source: string;
  target: string;
  mode: string;
}

export function parseMount(spec: string): ParsedMount | undefined {
  const parts = spec.split(':');
  if (parts.length < 2 || !parts[0] || !parts[1]) return undefined;
  return {
    source: parts[0],
    target: parts[1].replace(/\/+$/, '') || '/',
    mode: parts[2] || 'rw',
  };
}

function isPathPrefix(parent: string, child: string): boolean {
  return parent !== child && child.startsWith(parent === '/' ? '/' : `${parent}/`);
}

/**
 * Returns the deepest bind whose target strictly contains `target`. runc applies
 * binds parent-first, so this is the mount that owns the directory entry runc
 * must create for `target`.
 */
export function innermostCoveringMount(binds: ParsedMount[], target: string): ParsedMount | undefined {
  let best: ParsedMount | undefined;
  for (const bind of binds) {
    if (!isPathPrefix(bind.target, target)) continue;
    if (!best || bind.target.length > best.target.length) best = bind;
  }
  return best;
}

/**
 * Resolves a generated bind source to the equivalent path on the runner's own
 * filesystem, or `undefined` when that cannot be known.
 *
 * `undefined` means "do not touch": callers must fail closed (keep a credential
 * overlay, skip a mountpoint preparation) rather than act on a path that may
 * belong to the Docker daemon's filesystem instead of the runner's.
 */
export type LocalSourceResolver = (source: string) => string | undefined;

export function createLocalSourceResolver(
  customSourceRoots: Map<string, string>,
  dockerHostPathPrefix?: string,
): LocalSourceResolver {
  // The CLI only trims this value, so compare against the canonical form: a raw
  // `/host/` would otherwise fail the `/host/` prefix test and let a daemon-side
  // source be treated as runner-local.
  const normalizedPrefix = dockerHostPathPrefix
    ? normalizeDockerHostPathPrefix(dockerHostPathPrefix)
    : '';
  // `/` prefixes nothing: `translateBindMountHostPath` returns every mount
  // unchanged for it, so the generated sources are plain runner paths. Reading
  // it as a daemon root instead would make *every* absolute source
  // unattributable and fail the run closed before launch.
  const isNoOpPrefix = normalizedPrefix === '' || normalizedPrefix === '/';
  const daemonOnlyPrefix = !isNoOpPrefix && !isSharedDockerHostPathPrefix(normalizedPrefix)
    ? normalizedPrefix
    : '';

  return (source: string): string | undefined => {
    for (const [daemonRoot, localRoot] of customSourceRoots) {
      if (source !== daemonRoot && !isPathPrefix(daemonRoot, source)) continue;
      // A custom mount we cannot map back to a runner path: fail closed.
      if (!localRoot) return undefined;
      return `${localRoot}${source.slice(daemonRoot.length)}`;
    }

    // Not a custom mount. Every other source is still runner-local here because
    // `applyHostPathPrefixToVolumes` runs after this stage. A source that
    // already carries a *daemon-only* prefix cannot be attributed, so fail
    // closed.
    //
    // A shared prefix is not that case: there the same path is valid on both
    // sides, so the run's own workDir (and everything AWF stages) legitimately
    // sits under the prefix and stays runner-resolvable. Failing closed on it
    // instead would misclassify the entire run directory.
    if (daemonOnlyPrefix && isPathPrefix(daemonOnlyPrefix, source)) {
      return undefined;
    }

    return source;
  };
}

/** Default resolver for single-filesystem runs: sources are runner-local. */
export const identityLocalSourceResolver: LocalSourceResolver = (source) => source;
