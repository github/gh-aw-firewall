import type {
  MountTreeDependencies,
  MountTreeStats,
  MountTreeTools,
  StagedHostMountTreeOptions,
  VirtiofsdOverlayKind,
} from './mount-tree';
import { readTreeMountInfo } from './mount-tree-parse';
import type { MountInfoEntry } from './mount-tree-parse';
import { assertContainedPath } from './mount-tree-paths';

export interface ResolvedOverlay {
  readonly source: string;
  readonly stagedDestination: string;
  readonly kind: VirtiofsdOverlayKind;
}

export interface ResolvedMask {
  readonly stagedDestination: string;
}

const MINIMUM_UTIL_LINUX = { major: 2, minor: 23 } as const;

/**
 * Recursive read-only enforcement is applied one mount at a time rather than
 * through libmount's `ro=recursive` option argument: on util-linux 2.39.3 (the
 * GitHub-hosted Ubuntu 24.04 runner version) `mount -o rbind,ro=recursive` and
 * `mount -o remount,bind,ro=recursive` both succeed while leaving submounts
 * writable, which would be a silent security failure. Per-mount remounts work on
 * every supported version; `--make-rprivate` needs util-linux >= 2.23.
 */
export async function assertMountToolSupported(
  tools: MountTreeTools,
  dependencies: Pick<MountTreeDependencies, 'captureTool'>,
): Promise<void> {
  const output = await dependencies.captureTool(tools.mount, ['--version']);
  const match = /util-linux\s+(\d+)\.(\d+)/.exec(output);
  if (!match) {
    throw new Error(
      `Unable to determine util-linux version for host mount-tree enforcement from: ${output.trim()}`,
    );
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const supported =
    major > MINIMUM_UTIL_LINUX.major ||
    (major === MINIMUM_UTIL_LINUX.major && minor >= MINIMUM_UTIL_LINUX.minor);
  if (!supported) {
    throw new Error(
      `Host mount-tree enforcement requires util-linux >= ${MINIMUM_UTIL_LINUX.major}.` +
      `${MINIMUM_UTIL_LINUX.minor} for private mount propagation, found ${major}.${minor}`,
    );
  }
}

type VerificationOptions = Pick<StagedHostMountTreeOptions, 'rootPath' | 'directoryExport'> & {
  readonly dependencies: Pick<MountTreeDependencies, 'realpath' | 'statPath' | 'readMountInfo'>;
};

/** Stateless filesystem and mount checks; staging ownership stays with the caller. */
export class MountTreeVerifier {
  constructor(private readonly options: VerificationOptions) {}

  async assertRootIsCanonical(): Promise<void> {
    // Overlay destinations are validated by `realpath` equality against paths
    // built from this root, so the root itself has to be canonical for that
    // comparison to mean anything.
    const { rootPath, dependencies } = this.options;
    const resolvedRoot = await dependencies.realpath(rootPath);
    if (resolvedRoot !== rootPath) {
      throw new Error(
        `Staged mount tree root must be canonical: ${rootPath} resolves to ${resolvedRoot}`,
      );
    }
  }

  /**
   * Defense in depth: the overlay source lives in the still-writable original
   * export, so it is re-validated immediately before the bind. `realpath`
   * equality rejects symlinked components and any escape out of the export.
   */
  async assertOverlaySource(overlay: ResolvedOverlay): Promise<void> {
    const { dependencies, directoryExport } = this.options;
    const resolved = await dependencies.realpath(overlay.source);
    if (resolved !== overlay.source) {
      throw new Error(
        `Writable overlay source must be canonical: ${overlay.source} resolves to ${resolved}`,
      );
    }
    assertContainedPath(
      directoryExport.source,
      resolved,
      `export "${directoryExport.tag}" overlay source`,
    );
    const stats = await dependencies.statPath(overlay.source);
    assertStatsMatchKind(stats, overlay.kind, `writable overlay source ${overlay.source}`);
  }

  /**
   * The destination is inspected inside the staged tree, which is already
   * recursively read-only and privately propagated, so it cannot be swapped
   * between this check and the bind.
   *
   * `lstat` alone is not sufficient: it only reveals a symlink in the final
   * component, while the kernel resolves every intermediate component when it
   * binds. A staged `tools -> /etc` symlink would make `tools/sudoers` lstat as
   * an ordinary file and then bind over the host's `/etc/sudoers`. `realpath`
   * equality rejects a symlink in any component, and the containment check
   * keeps the resolved target inside the staged root.
   */
  async assertOverlayDestination(overlay: ResolvedOverlay): Promise<void> {
    const { dependencies, rootPath } = this.options;
    const label = `writable overlay destination ${overlay.stagedDestination}`;
    const resolved = await dependencies.realpath(overlay.stagedDestination);
    if (resolved !== overlay.stagedDestination) {
      throw new Error(
        `Writable overlay destination must be canonical: ${overlay.stagedDestination} resolves to ${resolved}`,
      );
    }
    assertContainedPath(rootPath, resolved, label);
    const stats = await dependencies.statPath(overlay.stagedDestination);
    assertStatsMatchKind(stats, overlay.kind, label);
  }

  async assertTreeIsReadonly(): Promise<void> {
    const entries = await readTreeMountInfo(this.options.dependencies, this.options.rootPath);
    assertRootMount(entries, this.options.rootPath);
    for (const entry of entries) {
      if (!entry.options.includes('ro')) {
        throw new Error(
          `Staged mount tree is not recursively read-only: ${entry.mountPoint} is writable`,
        );
      }
      assertHardenedOptions(entry);
      assertPrivatePropagation(entry);
    }
  }

  async assertOnlyOverlaysAreWritable(overlays: readonly ResolvedOverlay[]): Promise<void> {
    const expected = new Set(overlays.map((overlay) => overlay.stagedDestination));
    const entries = await readTreeMountInfo(this.options.dependencies, this.options.rootPath);
    const writable = new Set<string>();
    for (const entry of entries) {
      assertHardenedOptions(entry);
      assertPrivatePropagation(entry);
      if (entry.options.includes('ro')) continue;
      if (!expected.has(entry.mountPoint)) {
        throw new Error(
          `Unexpected writable mount in staged tree: ${entry.mountPoint}`,
        );
      }
      writable.add(entry.mountPoint);
    }
    for (const destination of expected) {
      if (!writable.has(destination)) {
        throw new Error(`Writable overlay was not applied: ${destination}`);
      }
    }
  }

  /**
   * Counterpart to {@link assertTreeIsReadonly} for a masks-only plan: the
   * staged root must stay read-write (masks are applied afterwards, on top of
   * this), but every mount still has to be hardened and privately propagated.
   */
  async assertTreeIsHardenedAndPrivate(): Promise<void> {
    const entries = await readTreeMountInfo(this.options.dependencies, this.options.rootPath);
    const root = assertRootMount(entries, this.options.rootPath);
    if (!root.options.includes('rw')) {
      throw new Error(`Staged mount tree root is not writable: ${this.options.rootPath}`);
    }
    for (const entry of entries) {
      assertHardenedOptions(entry);
      assertPrivatePropagation(entry);
    }
  }

  /**
   * Same rationale as {@link assertOverlayDestination}: the mask target is
   * inspected inside the already privately propagated staged tree, and
   * `realpath` equality rejects a symlink in any path component so a mask can
   * never be redirected onto an unrelated host directory.
   */
  async assertMaskDestination(mask: ResolvedMask): Promise<void> {
    const { dependencies, rootPath } = this.options;
    const label = `masked destination ${mask.stagedDestination}`;
    const resolved = await dependencies.realpath(mask.stagedDestination);
    if (resolved !== mask.stagedDestination) {
      throw new Error(
        `Masked destination must be canonical: ${mask.stagedDestination} resolves to ${resolved}`,
      );
    }
    assertContainedPath(rootPath, resolved, label);
    const stats = await dependencies.statPath(mask.stagedDestination);
    assertStatsMatchKind(stats, 'directory', label);
  }

  async assertMasksAreHidden(masks: readonly ResolvedMask[]): Promise<void> {
    if (masks.length === 0) return;
    const expected = new Set(masks.map((mask) => mask.stagedDestination));
    const entries = await readTreeMountInfo(this.options.dependencies, this.options.rootPath);
    const applied = new Set<string>();
    for (const entry of entries) {
      if (!expected.has(entry.mountPoint)) continue;
      if (!entry.options.includes('ro')) {
        throw new Error(`Masked mount is not read-only: ${entry.mountPoint}`);
      }
      assertHardenedOptions(entry);
      assertPrivatePropagation(entry);
      applied.add(entry.mountPoint);
    }
    for (const destination of expected) {
      if (!applied.has(destination)) {
        throw new Error(`Masked path was not applied: ${destination}`);
      }
    }
  }
}

export function assertRootMount(entries: readonly MountInfoEntry[], rootPath: string): MountInfoEntry {
  const root = entries.find((entry) => entry.mountPoint === rootPath);
  if (!root) {
    throw new Error(`Staged mount tree is missing its root mount: ${rootPath}`);
  }
  return root;
}

function assertPrivatePropagation(entry: MountInfoEntry): void {
  const propagation = entry.optionalFields.find(
    (field) =>
      field.startsWith('shared:') ||
      field.startsWith('master:') ||
      field.startsWith('propagate_from:'),
  );
  if (propagation !== undefined) {
    throw new Error(
      `Staged mount tree propagation would leak: ${entry.mountPoint} has ${propagation}`,
    );
  }
}

function assertHardenedOptions(entry: MountInfoEntry): void {
  for (const option of ['nosuid', 'nodev']) {
    if (!entry.options.includes(option)) {
      throw new Error(`Staged mount ${entry.mountPoint} is missing ${option}`);
    }
  }
}

export function remountOptionsSatisfied(entry: MountInfoEntry, remountOptions: string): boolean {
  const requested = new Set(remountOptions.split(','));
  const expectedMode = requested.has('ro') ? 'ro' : requested.has('rw') ? 'rw' : undefined;
  if (expectedMode !== undefined && !entry.options.includes(expectedMode)) return false;
  return ['nosuid', 'nodev'].every((option) => entry.options.includes(option)) &&
    !entry.optionalFields.some(
      (field) =>
        field.startsWith('shared:') ||
        field.startsWith('master:') ||
        field.startsWith('propagate_from:'),
    );
}

function assertStatsMatchKind(
  stats: MountTreeStats,
  kind: VirtiofsdOverlayKind,
  label: string,
): void {
  if (stats.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link`);
  }
  if (kind === 'directory' && !stats.isDirectory()) {
    throw new Error(`${label} must be an existing directory`);
  }
  if (kind === 'file' && !stats.isFile()) {
    throw new Error(`${label} must be an existing regular file`);
  }
}
