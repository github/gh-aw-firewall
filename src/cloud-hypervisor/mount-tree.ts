import type { CloudHypervisorDirectoryExport } from './exports';
import { readExactMounts, readTreeMountInfo } from './mount-tree-parse';
import type { MountInfoEntry } from './mount-tree-parse';
import {
  assertCleanAbsolutePath,
  assertContainedPath,
  assertNoOverlap,
  containsOrEquals,
  containsPath,
  pathDepth,
  stagedPathFor,
} from './mount-tree-paths';
import {
  assertMountToolSupported,
  assertRootMount,
  MountTreeVerifier,
  remountOptionsSatisfied,
} from './mount-tree-verify';
import type { ResolvedMask, ResolvedOverlay } from './mount-tree-verify';

export { parseMountInfo } from './mount-tree-parse';
export type { MountInfoEntry } from './mount-tree-parse';
export { assertMountToolSupported } from './mount-tree-verify';

/**
 * Host mount-tree enforcement for virtiofsd exports.
 *
 * Cloud Hypervisor v53 and virtiofsd v1.13 have no per-path read-only option, so
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

/**
 * A directory hidden from the guest entirely, regardless of the rest of the
 * export's mode. Its staged counterpart is replaced by an empty, read-only
 * tmpfs, so the guest cannot read the host content underneath -- unlike a
 * writable overlay, a mask never re-exposes host content.
 */
export interface VirtiofsdMaskOverlay {
  /**
   * Canonical, absolute host path, expressed in the original export
   * namespace, whose staged counterpart is replaced by an empty read-only
   * tmpfs.
   */
  readonly destination: string;
}

/** Enforcement request for one export, addressed by its export tag. */
export interface VirtiofsdExportMountPlan {
  readonly tag: string;
  readonly writableOverlays: readonly VirtiofsdWritableOverlay[];
  /**
   * Paths hidden from the guest regardless of the export's mode. Applied last
   * -- after the recursive read-only pass and writable overlays, or after the
   * plain private rbind used for a masks-only plan on an otherwise read-write
   * export -- so a masked directory can never be raced open by an earlier
   * overlay.
   */
  readonly maskedPaths?: readonly VirtiofsdMaskOverlay[];
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
  sleep(milliseconds: number): Promise<void>;
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

const MAX_WRITABLE_OVERLAYS = 64;
const MAX_MASKED_PATHS = 16;
const READONLY_REMOUNT_OPTIONS = 'remount,bind,ro,nosuid,nodev';
const WRITABLE_REMOUNT_OPTIONS = 'remount,bind,rw,nosuid,nodev';
const HARDENED_REMOUNT_OPTIONS = 'remount,bind,nosuid,nodev';
const MASK_MOUNT_OPTIONS = 'ro,nosuid,nodev,size=0,mode=000';
const BUSY_RETRY_ATTEMPTS = 5;
const BUSY_RETRY_INTERVAL_MS = 25;

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
  private readonly verifier: MountTreeVerifier;

  constructor(private readonly options: StagedHostMountTreeOptions) {
    this.verifier = new MountTreeVerifier(options);
  }

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
    const { overlays, masks } = this.resolveOverlaysAndMasks();
    try {
      // A plan with no writable overlays ordinarily locks the whole export
      // read-only -- the safe default for a zero-overlay plan, such as the
      // mandatory runner-tool-cache plan. A masks-only plan on an otherwise
      // read-write export is the one exception: it must leave everything but
      // the masked paths writable, so it skips the recursive read-only pass
      // entirely rather than reopening it with a writable overlay -- the
      // export root itself can never be a writable overlay destination (see
      // `resolveOverlaysAndMasks`'s disjointness check).
      if (this.options.directoryExport.mode === 'rw' && overlays.length === 0 && masks.length > 0) {
        await this.stageWritableRoot();
      } else {
        await this.stageReadonlyRoot();
        await this.stageWritableOverlays(overlays);
      }
      await this.stageMasks(masks);
      this.staged = true;
    } catch (error) {
      await this.rollback(error);
      throw error;
    }
  }

  async unmount(): Promise<void> {
    for (const target of this.cleanupOrder()) {
      // The staged root is a recursive bind, so it can carry submounts of its
      // own; children are single non-recursive binds and unmount directly.
      const args = target === this.rootPath ? ['-R', target] : [target];
      await this.unmountOwnedTarget(args, target);
      this.pendingMounts.delete(target);
    }
    this.staged = false;
    if (this.rootDirectoryCreated) {
      await this.removeRootDirectory();
      this.rootDirectoryCreated = false;
    }
  }

  private async stageReadonlyRoot(): Promise<void> {
    await this.stageRootBind(READONLY_REMOUNT_OPTIONS);
    await this.verifier.assertTreeIsReadonly();
  }

  /**
   * Used only for a masks-only plan on a read-write export: an rbind and
   * private-propagation pass identical to {@link stageReadonlyRoot}, but the
   * follow-up remount hardens each mount without changing its read-only state.
   */
  private async stageWritableRoot(): Promise<void> {
    await this.stageRootBind(HARDENED_REMOUNT_OPTIONS);
    await this.verifier.assertTreeIsHardenedAndPrivate();
  }

  private async stageRootBind(remountOptions: string): Promise<void> {
    const { dependencies, tools, directoryExport } = this.options;
    await assertMountToolSupported(tools, dependencies);
    await dependencies.mkdir(this.rootPath, { recursive: true, mode: 0o700 });
    this.rootDirectoryCreated = true;
    await this.verifier.assertRootIsCanonical();
    await dependencies.runTool(tools.mount, ['--rbind', directoryExport.source, this.rootPath]);
    this.pendingMounts.add(this.rootPath);
    // Private propagation before anything writable exists, so neither the
    // read-only attributes nor the later overlays can leak into the host or the
    // original export's peer group.
    await dependencies.runTool(tools.mount, ['--make-rprivate', this.rootPath]);
    const staged = await readTreeMountInfo(dependencies, this.rootPath);
    assertRootMount(staged, this.rootPath);
    const targets = staged
      .map((entry) => entry.mountPoint)
      .sort((left, right) => pathDepth(right) - pathDepth(left));
    for (const target of targets) {
      await this.remountOwnedTarget(remountOptions, target);
    }
  }

  private async remountOwnedTarget(remountOptions: string, target: string): Promise<void> {
    const { dependencies, tools } = this.options;
    const args = ['-o', remountOptions, target];
    for (let attempt = 1; attempt <= BUSY_RETRY_ATTEMPTS; attempt += 1) {
      try {
        await dependencies.runTool(tools.mount, args);
        return;
      } catch (error) {
        if (!isBusyMountError(error)) throw error;
        const entry = await this.readExactOwnedRemount(target, error);
        if (remountOptionsSatisfied(entry, remountOptions)) return;
        if (attempt === BUSY_RETRY_ATTEMPTS) throw error;
        await dependencies.sleep(BUSY_RETRY_INTERVAL_MS);
      }
    }
  }

  private async unmountOwnedTarget(args: readonly string[], target: string): Promise<void> {
    const { dependencies, tools } = this.options;
    for (let attempt = 1; attempt <= BUSY_RETRY_ATTEMPTS; attempt += 1) {
      try {
        await dependencies.runTool(tools.umount, args);
        return;
      } catch (error) {
        if (!isBusyMountError(error)) throw error;
        const entries = await readExactMounts(dependencies, target);
        if (entries.length === 0) return;
        this.assertOwnedTarget(target, 'unmount');
        if (attempt === BUSY_RETRY_ATTEMPTS) throw error;
        await dependencies.sleep(BUSY_RETRY_INTERVAL_MS);
      }
    }
  }

  private async readExactOwnedRemount(
    target: string,
    busyError: unknown,
  ): Promise<MountInfoEntry> {
    const entries = await readExactMounts(this.options.dependencies, target);
    if (entries.length !== 1) {
      throw new Error(
        `Refusing to reconcile busy remount for ambiguous staged mount ${target}: ` +
        `found ${entries.length} exact-path records; original error: ${formatError(busyError)}`,
      );
    }
    this.assertOwnedTarget(target, 'remount');
    return entries[0];
  }

  private assertOwnedTarget(target: string, operation: 'remount' | 'unmount'): void {
    if (
      !this.pendingMounts.has(this.rootPath) ||
      (target !== this.rootPath && !containsPath(this.rootPath, target)) ||
      (operation === 'unmount' && !this.pendingMounts.has(target))
    ) {
      throw new Error(
        `Refusing to retry busy ${operation} outside the owned staged mount tree: ${target}`,
      );
    }
  }

  private async removeRootDirectory(): Promise<void> {
    const { dependencies } = this.options;
    for (let attempt = 1; attempt <= BUSY_RETRY_ATTEMPTS; attempt += 1) {
      try {
        await dependencies.rmdir(this.rootPath);
        return;
      } catch (error) {
        if (!isBusyDirectoryError(error) || attempt === BUSY_RETRY_ATTEMPTS) throw error;
        await dependencies.sleep(BUSY_RETRY_INTERVAL_MS);
      }
    }
  }

  private async stageWritableOverlays(overlays: readonly ResolvedOverlay[]): Promise<void> {
    const { dependencies, tools } = this.options;
    for (const overlay of overlays) {
      await this.verifier.assertOverlaySource(overlay);
      await this.verifier.assertOverlayDestination(overlay);
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
      await this.remountOwnedTarget(WRITABLE_REMOUNT_OPTIONS, overlay.stagedDestination);
    }
    await this.verifier.assertOnlyOverlaysAreWritable(overlays);
  }

  private async stageMasks(masks: readonly ResolvedMask[]): Promise<void> {
    const { dependencies, tools } = this.options;
    for (const mask of masks) {
      await this.verifier.assertMaskDestination(mask);
      // A synthetic tmpfs, not a bind: there is no host source to leak, so it
      // is mounted read-only directly rather than bound and then remounted.
      await dependencies.runTool(tools.mount, [
        '-t',
        'tmpfs',
        '-o',
        MASK_MOUNT_OPTIONS,
        'none',
        mask.stagedDestination,
      ]);
      this.pendingMounts.add(mask.stagedDestination);
    }
    await this.verifier.assertMasksAreHidden(masks);
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

  private resolveOverlaysAndMasks(): { overlays: ResolvedOverlay[]; masks: ResolvedMask[] } {
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
    const maskedPaths = plan.maskedPaths ?? [];
    if (plan.writableOverlays.length === 0 && maskedPaths.length === 0) {
      return { overlays: [], masks: [] };
    }
    if (directoryExport.mode === 'ro' && plan.writableOverlays.length > 0) {
      throw new Error(
        `Read-only Cloud Hypervisor export "${directoryExport.tag}" cannot receive writable overlays`,
      );
    }
    if (plan.writableOverlays.length > MAX_WRITABLE_OVERLAYS) {
      throw new Error(
        `Cloud Hypervisor export "${directoryExport.tag}" exceeds ${MAX_WRITABLE_OVERLAYS} writable overlays`,
      );
    }
    if (maskedPaths.length > MAX_MASKED_PATHS) {
      throw new Error(
        `Cloud Hypervisor export "${directoryExport.tag}" exceeds ${MAX_MASKED_PATHS} masked paths`,
      );
    }
    const destinations: string[] = [];
    const overlays = plan.writableOverlays.map((overlay) => {
      const label = `export "${directoryExport.tag}" overlay`;
      if (overlay.kind !== 'file' && overlay.kind !== 'directory') {
        throw new Error(`Invalid ${label} kind: ${String(overlay.kind)}`);
      }
      assertCleanAbsolutePath(overlay.source, `${label} source`);
      assertCleanAbsolutePath(overlay.destination, `${label} destination`);
      assertContainedPath(directoryExport.source, overlay.source, `${label} source`);
      assertContainedPath(directoryExport.source, overlay.destination, `${label} destination`);
      assertNoOverlap(destinations, overlay.destination, label);
      destinations.push(overlay.destination);
      return {
        source: overlay.source,
        stagedDestination: stagedPathFor(rootPath, directoryExport.source, overlay.destination),
        kind: overlay.kind,
      };
    });

    const maskDestinations: string[] = [];
    const masks = maskedPaths.map((mask) => {
      const label = `export "${directoryExport.tag}" mask`;
      assertCleanAbsolutePath(mask.destination, `${label} destination`);
      assertContainedPath(directoryExport.source, mask.destination, `${label} destination`);
      assertNoOverlap(maskDestinations, mask.destination, label);
      // A mask can never overlap a writable overlay: one hides the path from
      // the guest entirely, the other re-exposes host content there. Letting
      // both apply to the same path would make the outcome depend on staging
      // order instead of failing closed.
      if (destinations.some((existing) => containsOrEquals(existing, mask.destination))) {
        throw new Error(
          `Cloud Hypervisor ${label} destination overlaps a writable overlay: ${mask.destination}`,
        );
      }
      maskDestinations.push(mask.destination);
      return { stagedDestination: stagedPathFor(rootPath, directoryExport.source, mask.destination) };
    });

    // Shallow paths first so a parent mount point always exists before a child.
    return {
      overlays: overlays.sort(
        (left, right) => pathDepth(left.stagedDestination) - pathDepth(right.stagedDestination),
      ),
      masks: masks.sort(
        (left, right) => pathDepth(left.stagedDestination) - pathDepth(right.stagedDestination),
      ),
    };
  }
}

function isBusyMountError(error: unknown): boolean {
  if ((error as NodeJS.ErrnoException | undefined)?.code === 'EBUSY') return true;
  return error instanceof Error &&
    /(?:(?:mount point|target|resource) is busy|device or resource busy)/i.test(error.message);
}

function isBusyDirectoryError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EBUSY' || code === 'ENOTEMPTY';
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
