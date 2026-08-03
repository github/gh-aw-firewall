import * as fs from 'fs';
import * as path from 'path';
import type { BoundedAgentRepository } from '../types/bounded-agent-options';
import {
  stageBoundedQuerySeeds,
  type GitRunner,
} from '../bounded-query/staging';
import type { PrivateRepositoryStagingResult } from '../bounded-execution/repository-staging';
import type { BoundedAgentPaths } from './paths';

/**
 * Trusted host-side staging for bounded agents.
 *
 * Staging is *identical work* to bounded queries — clone one immutable seed
 * per configured repository, scrub every credential/hook/external-reference
 * artifact, make it read-only, and verify that — so this module deliberately
 * delegates to the audited implementation in `../bounded-query/staging.ts`
 * rather than restating it. What differs is only the destination: bounded
 * agents stage into their own disjoint private root (see `./paths.ts`), so the
 * two subsystems never share a seed, a workspace, an audit log, or a ledger.
 *
 * The staging credential is read from the AWF host environment, used only by
 * this phase through a `GIT_ASKPASS` helper reading a 0600 file, and scrubbed
 * before the broker, the enclave, or the primary agent exists.
 */

export interface StageBoundedAgentSeedsParams {
  /** Trusted repository descriptors exactly as configured (already schema-validated). */
  repos: BoundedAgentRepository[];
  /** Resolved bounded-agent filesystem layout. */
  paths: Pick<BoundedAgentPaths, 'root' | 'seedsDir'>;
  /** Run-unique id used to derive opaque seed directory names. */
  runId: string;
  /** Staging credential. Never logged, never forwarded past the staging phase. */
  token: string;
  /** Override the git runner (tests). */
  gitRunner?: GitRunner;
}

/** Materializes an immutable seed for every configured bounded-agent repository. */
function makeSeedEnclaveReadable(target: string): void {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) return;

  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(target)) {
      makeSeedEnclaveReadable(path.join(target, entry));
    }
    fs.chmodSync(target, (stat.mode & 0o7777) | 0o555);
    return;
  }

  fs.chmodSync(target, (stat.mode & 0o7777) | 0o444);
}

export async function stageBoundedAgentSeeds(
  params: StageBoundedAgentSeedsParams,
): Promise<PrivateRepositoryStagingResult> {
  const result = await stageBoundedQuerySeeds({
    repos: params.repos,
    paths: params.paths,
    runId: params.runId,
    token: params.token,
    gitRunner: params.gitRunner,
    label: 'Bounded agents',
  });

  // The enclave runs as fixed uid/gid 65534 and bind-mounts the immutable seed
  // directly. Grant read/traverse permission without restoring any write bit.
  for (const seed of result.seeds) {
    makeSeedEnclaveReadable(seed.seedPath);
  }
  return result;
}

export { releaseSeedPermissions, resolveStagingToken } from '../bounded-query/staging';
export type { GitRunner } from '../bounded-query/staging';

/** @internal Exported for focused permission tests. */
// ts-prune-ignore-next
export const boundedAgentStagingTestHelpers = { makeSeedEnclaveReadable };
