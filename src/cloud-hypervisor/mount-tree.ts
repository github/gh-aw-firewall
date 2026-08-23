import * as path from 'path';
import type { CloudHypervisorDirectoryExport } from './exports';

/**
 * Host mount-tree enforcement for virtiofsd exports.
 *
 * Cloud Hypervisor v53 and virtiofsd v1.10 have no per-path read-only option, so
 * a mixed read-only/read-write export cannot be expressed inside the guest. The
 * only trustworthy boundary is the host VFS: stage a private mount tree that is
 * recursively read-only and then bind the few writable paths back in as nested
 * read-write child mounts. virtiofsd then shares the staged tree and announces
 * the submounts so the guest observes each child mount separately.
 */

export type VirtiofsdOverlayKind = 'file' | 'directory';

/** A single writable path carved out of an otherwise read-only staged export. */
export interface VirtiofsdWritableOverlay {
  /**
   * Canonical, absolute host path that provides the writable content. Must
   * already resolve inside the export source.
   */
  readonly source: string;
  /**
   * Canonical, absolute host path, expressed in the original export namespace,
   * whose staged counterpart becomes writable.
   */
  readonly destination: string;
  /** Expected type of both `source` and `destination`. */
  readonly kind: VirtiofsdOverlayKind;
}

/** Enforcement request for one export, addressed by its export tag. */
export interface VirtiofsdExportMountPlan {
  readonly tag: string;
  readonly writableOverlays: readonly VirtiofsdWritableOverlay[];
}

/**
 * Optional enforcement input for {@link VirtiofsdManager}. When absent, or when
 * no plan matches an export tag, the export is staged exactly as before.
 */
export interface VirtiofsdMountEnforcement {
  readonly plans: readonly VirtiofsdExportMountPlan[];
}

export interface MountTreeStats {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

/** Command/filesystem abstraction so the staging logic is fully testable. */
export interface MountTreeDependencies {
  mkdir(directory: string, options: { recursive: true; mode: number }): Promise<unknown>;
  rmdir(directory: string): Promise<void>;
  runTool(command: string, args: readonly string[]): Promise<void>;
  captureTool(command: string, args: readonly string[]): Promise<string>;
  statPath(filePath: string): Promise<MountTreeStats>;
  realpath(filePath: string): Promise<string>;
  readMountInfo(): Promise<string>;
}

export interface MountTreeTools {
  readonly mount: string;
  readonly umount: string;
}

export interface StagedHostMountTreeOptions {
  readonly directoryExport: CloudHypervisorDirectoryExport;
  readonly rootPath: string;
  readonly plan: VirtiofsdExportMountPlan;
  readonly tools: MountTreeTools;
  readonly dependencies: MountTreeDependencies;
}

interface ResolvedOverlay {
  readonly source: string;
  readonly stagedDestination: string;
  readonly kind: VirtiofsdOverlayKind;
}

export interface MountInfoEntry {
  readonly mountPoint: string;
  readonly options: readonly string[];
  readonly optionalFields: readonly string[];
}

const MAX_WRITABLE_OVERLAYS = 64;
const READONLY_REMOUNT_OPTIONS = 'remount,bind,ro,nosuid,nodev';
const WRITABLE_REMOUNT_OPTIONS = 'remount,bind,rw,nosuid,nodev';
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
  dependencies: MountTreeDependencies,
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

export function selectMountPlan(
  enforcement: VirtiofsdMountEnforcement | undefined,
  tag: string,
): VirtiofsdExportMountPlan | undefined {
  if (!enforcement) return undefined;
  const matches = enforcement.plans.filter((plan) => plan.tag === tag);
  if (matches.length > 1) {
    throw new Error(`Duplicate Cloud Hypervisor mount plan for export tag: ${tag}`);
  }
  return matches[0];
}

/**
 * Fails closed when a plan names an export that does not exist. A silently
 * dropped plan would downgrade that export to unrestricted read-write, so a
 * renamed or mistyped tag must be an error. Exports without a plan keep their
 * existing behaviour, which is what makes partial enforcement possible.
 */
export function assertPlansMatchExports(
  enforcement: VirtiofsdMountEnforcement | undefined,
  exports: readonly { readonly tag: string }[],
): void {
  if (!enforcement) return;
  const known = new Set(exports.map((item) => item.tag));
  const unknown = enforcement.plans
    .map((plan) => plan.tag)
    .filter((tag) => !known.has(tag));
  if (unknown.length > 0) {
    throw new Error(
      `Cloud Hypervisor mount plans reference unknown export tags: ${[...new Set(unknown)].sort().join(', ')}`,
    );
  }
}

/**
 * A staged mount tree. Instances are created unmounted; {@link stage} performs
 * the privileged work and {@link unmount} tears it down deepest-first. Failed
 * unmounts stay pending so a later call can retry them.
 */
export class StagedHostMountTree {
  private readonly pendingMounts = new Set<string>();
  private rootDirectoryCreated = false;
  private staged = false;

  constructor(private readonly options: StagedHostMountTreeOptions) {}

  get rootPath(): string {
    return this.options.rootPath;
  }

  /** True while host state (mounts or the staging directory) still exists. */
  get hasResidue(): boolean {
    return this.pendingMounts.size > 0 || this.rootDirectoryCreated;
  }

  get isStaged(): boolean {
    return this.staged;
  }

  /** Cleanup order: writable children deepest-first, staged root last. */
  cleanupOrder(): string[] {
    return [...this.pendingMounts].sort((left, right) => {
      const depth = pathDepth(right) - pathDepth(left);
      return depth !== 0 ? depth : right.localeCompare(left);
    });
  }

  async stage(): Promise<void> {
    if (this.staged) throw new Error(`Mount tree already staged: ${this.rootPath}`);
    const overlays = this.resolveOverlays();
    try {
      await this.stageReadonlyRoot();
      await this.stageWritableOverlays(overlays);
      this.staged = true;
    } catch (error) {
      await this.rollback(error);
      throw error;
    }
  }

  async unmount(): Promise<void> {
    const { dependencies, tools } = this.options;
    for (const target of this.cleanupOrder()) {
      // The staged root is a recursive bind, so it can carry submounts of its
      // own; children are single non-recursive binds and unmount directly.
      const args = target === this.rootPath ? ['-R', target] : [target];
      await dependencies.runTool(tools.umount, args);
      this.pendingMounts.delete(target);
    }
    this.staged = false;
    if (this.rootDirectoryCreated) {
      await dependencies.rmdir(this.rootPath);
      this.rootDirectoryCreated = false;
    }
  }

  private async stageReadonlyRoot(): Promise<void> {
    const { dependencies, tools, directoryExport } = this.options;
    await assertMountToolSupported(tools, dependencies);
    await dependencies.mkdir(this.rootPath, { recursive: true, mode: 0o700 });
    this.rootDirectoryCreated = true;
    // Overlay destinations are validated by `realpath` equality against paths
    // built from this root, so the root itself has to be canonical for that
    // comparison to mean anything.
    const resolvedRoot = await dependencies.realpath(this.rootPath);
    if (resolvedRoot !== this.rootPath) {
      throw new Error(
        `Staged mount tree root must be canonical: ${this.rootPath} resolves to ${resolvedRoot}`,
      );
    }
    await dependencies.runTool(tools.mount, ['--rbind', directoryExport.source, this.rootPath]);
    this.pendingMounts.add(this.rootPath);
    // Private propagation before anything writable exists, so neither the
    // read-only attributes nor the later overlays can leak into the host or the
    // original export's peer group.
    await dependencies.runTool(tools.mount, ['--make-rprivate', this.rootPath]);
    const staged = await this.readTreeMountInfo();
    if (!staged.some((entry) => entry.mountPoint === this.rootPath)) {
      throw new Error(`Staged mount tree is missing its root mount: ${this.rootPath}`);
    }
    const targets = staged
      .map((entry) => entry.mountPoint)
      .sort((left, right) => pathDepth(right) - pathDepth(left));
    for (const target of targets) {
      await dependencies.runTool(tools.mount, ['-o', READONLY_REMOUNT_OPTIONS, target]);
    }
    await this.assertTreeIsReadonly();
  }

  private async stageWritableOverlays(overlays: readonly ResolvedOverlay[]): Promise<void> {
    const { dependencies, tools } = this.options;
    for (const overlay of overlays) {
      await this.assertOverlaySource(overlay);
      await this.assertOverlayDestination(overlay);
      // Non-recursive bind: a writable directory never exposes submounts nested
      // inside it. The follow-up remount sets the flags explicitly instead of
      // inheriting whatever the source mount carried.
      await dependencies.runTool(tools.mount, [
        '--bind',
        overlay.source,
        overlay.stagedDestination,
      ]);
      this.pendingMounts.add(overlay.stagedDestination);
      // A new bind mount joins the *source's* peer group, so an overlay bound
      // from a shared host mount (the default for `/` under systemd, and what
      // GitHub-hosted runners provide) arrives shared even though the staged
      // root was already made private. Making the root private beforehand only
      // covers mounts that existed at that point, so each overlay has to be
      // made private in turn -- otherwise the writable overlay would propagate
      // back into the host peer group and `assertPrivatePropagation()` would
      // (correctly) refuse to stage the tree at all.
      await dependencies.runTool(tools.mount, ['--make-rprivate', overlay.stagedDestination]);
      await dependencies.runTool(tools.mount, [
        '-o',
        WRITABLE_REMOUNT_OPTIONS,
        overlay.stagedDestination,
      ]);
    }
    await this.assertOnlyOverlaysAreWritable(overlays);
  }

  private async rollback(cause: unknown): Promise<void> {
    try {
      await this.unmount();
    } catch (cleanupError) {
      // Residue stays pending so the owning manager can retry it during stop().
      throw new Error(
        `${formatError(cause)}; staged mount cleanup failed: ${formatError(cleanupError)}`,
      );
    }
  }

  private resolveOverlays(): ResolvedOverlay[] {
    const { directoryExport, plan, rootPath } = this.options;
    if (plan.tag !== directoryExport.tag) {
      throw new Error(
        `Mount plan tag "${plan.tag}" does not match export tag "${directoryExport.tag}"`,
      );
    }
    assertCleanAbsolutePath(rootPath, `staged root for export "${directoryExport.tag}"`);
    // A staged root inside the export (or an export inside the staged root)
    // would make the recursive bind contain itself.
    if (
      rootPath === directoryExport.source ||
      containsPath(directoryExport.source, rootPath) ||
      containsPath(rootPath, directoryExport.source)
    ) {
      throw new Error(
        `Staged mount tree root ${rootPath} must be disjoint from export "${directoryExport.tag}" ` +
        `source ${directoryExport.source}`,
      );
    }
    if (plan.writableOverlays.length === 0) return [];
    if (directoryExport.mode === 'ro') {
      throw new Error(
        `Read-only Cloud Hypervisor export "${directoryExport.tag}" cannot receive writable overlays`,
      );
    }
    if (plan.writableOverlays.length > MAX_WRITABLE_OVERLAYS) {
      throw new Error(
        `Cloud Hypervisor export "${directoryExport.tag}" exceeds ${MAX_WRITABLE_OVERLAYS} writable overlays`,
      );
    }
    const destinations: string[] = [];
    const resolved = plan.writableOverlays.map((overlay) => {
      const label = `export "${directoryExport.tag}" overlay`;
      if (overlay.kind !== 'file' && overlay.kind !== 'directory') {
        throw new Error(`Invalid ${label} kind: ${String(overlay.kind)}`);
      }
      assertCleanAbsolutePath(overlay.source, `${label} source`);
      assertCleanAbsolutePath(overlay.destination, `${label} destination`);
      assertContainedPath(directoryExport.source, overlay.source, `${label} source`);
      assertContainedPath(directoryExport.source, overlay.destination, `${label} destination`);
      for (const existing of destinations) {
        if (existing === overlay.destination) {
          throw new Error(`Duplicate ${label} destination: ${overlay.destination}`);
        }
        if (containsPath(existing, overlay.destination) || containsPath(overlay.destination, existing)) {
          throw new Error(
            `Overlapping ${label} destinations: ${existing} and ${overlay.destination}`,
          );
        }
      }
      destinations.push(overlay.destination);
      return {
        source: overlay.source,
        stagedDestination: path.join(
          rootPath,
          path.relative(directoryExport.source, overlay.destination),
        ),
        kind: overlay.kind,
      };
    });
    // Shallow paths first so a parent mount point always exists before a child.
    return resolved.sort((left, right) => pathDepth(left.stagedDestination) - pathDepth(right.stagedDestination));
  }

  /**
   * Defense in depth: the overlay source lives in the still-writable original
   * export, so it is re-validated immediately before the bind. `realpath`
   * equality rejects symlinked components and any escape out of the export.
   */
  private async assertOverlaySource(overlay: ResolvedOverlay): Promise<void> {
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
  private async assertOverlayDestination(overlay: ResolvedOverlay): Promise<void> {
    const { dependencies } = this.options;
    const label = `writable overlay destination ${overlay.stagedDestination}`;
    const resolved = await dependencies.realpath(overlay.stagedDestination);
    if (resolved !== overlay.stagedDestination) {
      throw new Error(
        `Writable overlay destination must be canonical: ${overlay.stagedDestination} resolves to ${resolved}`,
      );
    }
    assertContainedPath(this.rootPath, resolved, label);
    const stats = await dependencies.statPath(overlay.stagedDestination);
    assertStatsMatchKind(stats, overlay.kind, label);
  }

  private async assertTreeIsReadonly(): Promise<void> {
    const entries = await this.readTreeMountInfo();
    if (!entries.some((entry) => entry.mountPoint === this.rootPath)) {
      throw new Error(`Staged mount tree is missing its root mount: ${this.rootPath}`);
    }
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

  private async assertOnlyOverlaysAreWritable(overlays: readonly ResolvedOverlay[]): Promise<void> {
    const expected = new Set(overlays.map((overlay) => overlay.stagedDestination));
    const entries = await this.readTreeMountInfo();
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

  private async readTreeMountInfo(): Promise<MountInfoEntry[]> {
    const entries = parseMountInfo(await this.options.dependencies.readMountInfo());
    return entries.filter(
      (entry) => entry.mountPoint === this.rootPath || containsPath(this.rootPath, entry.mountPoint),
    );
  }
}

export function parseMountInfo(contents: string): MountInfoEntry[] {
  const entries: MountInfoEntry[] = [];
  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const fields = trimmed.split(' ');
    const separator = fields.indexOf('-');
    if (fields.length < 7 || separator < 6) continue;
    entries.push({
      mountPoint: unescapeMountInfoPath(fields[4]),
      options: fields[5].split(','),
      optionalFields: fields.slice(6, separator),
    });
  }
  return entries;
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

function assertCleanAbsolutePath(value: string, label: string): void {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    value === '/' ||
    value.endsWith('/') ||
    value.includes('\0') ||
    Buffer.byteLength(value) > 4096
  ) {
    throw new Error(`Cloud Hypervisor ${label} must be an absolute clean non-root path: ${value}`);
  }
}

function assertContainedPath(parent: string, child: string, label: string): void {
  if (!containsPath(parent, child)) {
    throw new Error(`Cloud Hypervisor ${label} must stay inside ${parent}: ${child}`);
  }
}

function containsPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function pathDepth(value: string): number {
  return value.split(path.sep).length;
}

function unescapeMountInfoPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, code: string) =>
    String.fromCharCode(parseInt(code, 8)),
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
