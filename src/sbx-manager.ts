/**
 * Docker sbx microVM lifecycle facade.
 *
 * Infrastructure remains in Docker Compose; sbx egress is chained through
 * AWF's Squid via the daemon's DOCKER_SANDBOXES_PROXY. Each lifecycle owns its
 * credential backups from create until removal and successful restoration.
 */
import execa from 'execa';
import { logger } from './logger';
import { CredentialScrubHandle } from './sbx/credential-scrub';
import {
  createSandboxInternal,
  sanitizeEnvForSbx,
  SbxCreateConfig,
  withCreateSandboxEnvironment,
} from './sbx/sandbox-create';
import { withLocalBinOnPath } from './sbx/sandbox-exec';

export { SBX_DEFAULT_NAME } from './sbx/sandbox-create';
export { execInSandbox } from './sbx/sandbox-exec';
export { assertSbxApiProxyReflect, assertSbxEgressEnforced } from './sbx/sandbox-verify';

/**
 * @internal Test isolation seam; production uses the default shared lifecycle.
 * An independent lifecycle's credential state and create guard.
 * Serialize creation across instances because the CLI mutates process.env.
 * Lifecycles sharing a host home must not overlap: one instance's restoration
 * would expose credentials through another instance's still-live home mounts.
 */
export class SbxLifecycleManager {
  private readonly credentials = new CredentialScrubHandle();
  private sandboxCreationInProgress = false;

  async createSandbox(config: SbxCreateConfig): Promise<string> {
    if (this.sandboxCreationInProgress) {
      throw new Error('Cannot create another sbx sandbox while sandbox creation is in progress');
    }
    if (this.credentials.hasPendingRestoration) {
      throw new Error(
        'Cannot create another sbx sandbox while previous credential backups still need restoration',
      );
    }

    this.sandboxCreationInProgress = true;
    try {
      return await createSandboxInternal(config, this.credentials);
    } finally {
      this.sandboxCreationInProgress = false;
    }
  }

  restoreHomeCredentials(): void {
    this.credentials.restoreHomeCredentials();
  }

  /** Stops and removes the sandbox, retaining the existing failed-rm policy. */
  async removeSandbox(name: string): Promise<void> {
    logger.info(`Removing sandbox "${name}"...`);

    try {
      const stopResult = await execa('sbx', ['stop', name], {
        stdio: ['ignore', 'pipe', 'pipe'],
        reject: false,
      });
      if ((stopResult.exitCode ?? 1) !== 0) {
        const stderr = stopResult.stderr?.trim();
        logger.warn(
          `Failed to stop sandbox "${name}" (exit ${(stopResult.exitCode ?? 1)}${stderr ? `: ${stderr}` : ''})`
        );
      }
    } catch {
      // stop may fail if already stopped — that's fine
    }

    const rmResult = await execa('sbx', ['rm', '--force', name], {
      stdio: ['ignore', 'pipe', 'pipe'],
      reject: false,
    });
    if ((rmResult.exitCode ?? 1) !== 0) {
      const stderr = rmResult.stderr?.trim();
      logger.warn(
        `Failed to remove sandbox "${name}" (exit ${(rmResult.exitCode ?? 1)}${stderr ? `: ${stderr}` : ''})`
      );
      // Preserve the existing behavior even if sbx rm reports failure.
      this.restoreHomeCredentials();
      return;
    }

    // Sandbox is gone (mounts released) → safe to move credentials back.
    this.restoreHomeCredentials();
    logger.info(`Sandbox "${name}" removed`);
  }
}

const defaultLifecycle = new SbxLifecycleManager();

/** Creates a sandbox using the default, single-sandbox-per-run lifecycle. */
export async function createSandbox(config: SbxCreateConfig): Promise<string> {
  return defaultLifecycle.createSandbox(config);
}

/** Stops and removes the sandbox using the default lifecycle. */
export async function removeSandbox(name: string): Promise<void> {
  return defaultLifecycle.removeSandbox(name);
}

/** Checks if the sbx CLI is available on the system. */
export async function isSbxAvailable(): Promise<boolean> {
  try {
    await execa('sbx', ['version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** @internal Exposed for unit tests only. */
// ts-prune-ignore-next
export const testHelpers = {
  sanitizeEnvForSbx,
  restoreHomeCredentials: () => defaultLifecycle.restoreHomeCredentials(),
  withCreateSandboxEnvironment,
  withLocalBinOnPath,
};
