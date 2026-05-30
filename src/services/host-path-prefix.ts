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

function normalizeDockerHostPathPrefix(prefix: string): string {
  const trimmed = prefix.trim();
  if (!trimmed) return '';
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const withoutTrailingSlash = withLeadingSlash.replace(/\/+$/, '');
  return withoutTrailingSlash || '/';
}

function shouldPreserveUnprefixedEtcIdentityFile(hostPath: string, dockerHostPathPrefix: string): boolean {
  return (
    (dockerHostPathPrefix === '/tmp' || dockerHostPathPrefix.startsWith('/tmp/')) &&
    (hostPath === '/etc/passwd' || hostPath === '/etc/group')
  );
}

function translateBindMountHostPath(mount: string, dockerHostPathPrefix: string): string {
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

  if (hostPath === dockerHostPathPrefix || hostPath.startsWith(`${dockerHostPathPrefix}/`)) {
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
export function applyHostPathPrefixToVolumes(volumes: string[], dockerHostPathPrefix: string | undefined): string[] {
  if (!dockerHostPathPrefix) return volumes;
  const normalized = normalizeDockerHostPathPrefix(dockerHostPathPrefix);
  if (!normalized) return volumes;
  return volumes.map(mount => translateBindMountHostPath(mount, normalized));
}
