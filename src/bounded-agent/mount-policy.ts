import type { WrapperConfig } from '../types';
import { assertPrivateRootIsolated } from '../bounded-query/mount-policy';
import type { BoundedAgentPaths } from './paths';

/**
 * Fails closed when the bounded-agent broker-private root aliases, contains,
 * or is contained by any path visible to a primary agent in any supported
 * sandbox backend.
 *
 * The agent-visible path union is backend-independent and identical for both
 * bounded subsystems, so this delegates to the audited shared implementation
 * rather than restating it. Only the roots being checked differ.
 */
export function assertBoundedAgentPrivateRootIsolated(
  config: WrapperConfig,
  paths: Pick<BoundedAgentPaths, 'root' | 'ingressRoot'>,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): void {
  assertPrivateRootIsolated(config, paths, env, cwd, 'bounded-agent');
}
