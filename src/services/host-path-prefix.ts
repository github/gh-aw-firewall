// Helpers for rewriting Docker bind-mount source paths so the daemon can
// resolve them on split runner/Docker daemon filesystems (e.g. ARC + DinD).
//
// When the runner process and the Docker daemon do not share the same root
// filesystem, bind-mount sources resolved on the runner side are not visible
// to the daemon. The user can stage the runner filesystem (or part of it)
// under a known location inside the daemon (commonly /host) and pass
// `--docker-host-path-prefix /host` so AWF rewrites every bind-mount source
// from `/foo` to `/host/foo` before handing the compose file to docker.
//
// These helpers are shared by all service builders (agent, iptables-init,
// squid, api-proxy, cli-proxy) so the rewrite is symmetric across services
// that share daemon-side directories.

/**
 * Canonical form of a `--docker-host-path-prefix` value: leading slash, no
 * trailing slash. Exported so every pass compares against the same string —
 * a raw `/host/` fails a `/host/`-prefix test that a normalised `/host` passes.
 */
export function normalizeDockerHostPathPrefix(prefix: string): string {
  const trimmed = prefix.trim();
  if (!trimmed) return '';
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const withoutTrailingSlash = withLeadingSlash.replace(/\/+$/, '');
  return withoutTrailingSlash || '/';
}

/**
 * Is this prefix a directory the runner and the Docker daemon *share*, rather
 * than a daemon-only staging root?
 *
 * A /tmp-rooted prefix is the ARC/DinD shared-volume shape: the same path
 * resolves to the same bytes on both sides. That is why AWF can stage files
 * into it with ordinary local `fs` calls, why an already-/tmp source is never
 * rewritten below, and why a source under it stays runner-resolvable. A prefix
 * like `/host` is the opposite: it exists only inside the daemon.
 *
 * Exported because every pass that reasons about prefixed paths needs the same
 * answer — keeping separate copies of this test is what let a shared prefix be
 * mistaken for a daemon-only one.
 */
export function isSharedDockerHostPathPrefix(prefix: string | undefined): boolean {
  if (!prefix) return false;
  const normalized = normalizeDockerHostPathPrefix(prefix);
  return normalized === '/tmp' || normalized.startsWith('/tmp/');
}

function shouldPreserveUnprefixedEtcIdentityFile(hostPath: string, dockerHostPathPrefix: string): boolean {
  return (
    isSharedDockerHostPathPrefix(dockerHostPathPrefix) &&
    (hostPath === '/etc/passwd' || hostPath === '/etc/group')
  );
}

interface HostPathPrefixOptions {
  translateAlreadyPrefixedPaths?: boolean;
}

function translateBindMountHostPath(
  mount: string,
  dockerHostPathPrefix: string,
  options: HostPathPrefixOptions = {},
): string {
  const parts = mount.split(':');
  if (parts.length < 2 || parts.length > 3) {
    return mount;
  }

  const [hostPath, containerPath, mode] = parts;
  if (!hostPath.startsWith('/')) {
    return mount;
  }

  // Skip kernel virtual filesystems — /dev, /sys, and /proc are provided by the
  // Docker daemon's own kernel, not staged runner paths. Prefixing them would look
  // for non-existent directories under the runner root.
  // SECURITY: /dev/null must be preserved for credential-hiding overlays.
  // /proc is not bind-mounted (it's a fresh procfs via mount -t proc in entrypoint.sh
  // with hidepid=2), but is included defensively to prevent accidental exposure of
  // /proc/*/environ which contains auth credentials.
  if (hostPath === '/dev/null' || hostPath.startsWith('/dev') || hostPath.startsWith('/sys') || hostPath.startsWith('/proc')) {
    return mount;
  }

  if (shouldPreserveUnprefixedEtcIdentityFile(hostPath, dockerHostPathPrefix)) {
    return mount;
  }

  if (dockerHostPathPrefix === '/') {
    return mount;
  }

  if (
    !options.translateAlreadyPrefixedPaths
    && (hostPath === dockerHostPathPrefix || hostPath.startsWith(`${dockerHostPathPrefix}/`))
  ) {
    return mount;
  }

  const translatedHostPath = hostPath === '/'
    ? dockerHostPathPrefix
    : `${dockerHostPathPrefix}${hostPath}`;

  return mode ? `${translatedHostPath}:${containerPath}:${mode}` : `${translatedHostPath}:${containerPath}`;
}

// Applies dockerHostPathPrefix translation to every bind mount in the list.
// Returns the input unchanged when no prefix is set or the prefix normalises
// to an empty string. Service builders call this at the end of their volume
// list construction so the rewrite is consistent across the compose stack.
export function applyHostPathPrefixToVolumes(
  volumes: string[],
  dockerHostPathPrefix: string | undefined,
  options: HostPathPrefixOptions = {},
): string[] {
  if (!dockerHostPathPrefix) return volumes;
  const normalized = normalizeDockerHostPathPrefix(dockerHostPathPrefix);
  if (!normalized) return volumes;
  return volumes.map(mount => translateBindMountHostPath(mount, normalized, options));
}
