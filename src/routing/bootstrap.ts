import * as fs from 'fs';
import * as path from 'path';
import { TextDecoder } from 'util';
import type { WrapperConfig, ModelRoutingBootstrapState } from '../types';
import { getRealUserHome, getSafeHostGid, getSafeHostUid } from '../host-identity';
import { isDigestPinnedImageReference } from '../image-reference';
import { resolveRuntimeImageFor } from '../image-resolver';
import { runtimeUsesComposeAgent } from '../container-runtime';
import { findDockerSocketExposingMount } from '../enclave/mount-policy';
import { applyHostPathPrefixToVolumes } from '../services/host-path-prefix';

// Import the proxy-owned validator through its declaration file so the host and
// proxy keep one contract for the staged planning conversation.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { validateConversation } = require('../../containers/api-proxy/routing-contract') as typeof import('../../containers/api-proxy/routing-contract');

export const ROUTING_CONTAINER_INPUT_DIR = '/run/awf-routing/input';
export const ROUTING_CONTAINER_OUTPUT_DIR = '/run/awf-routing/output';
export const ROUTING_CONTAINER_CONVERSATION_FILE = `${ROUTING_CONTAINER_INPUT_DIR}/conversation.json`;
export const ROUTING_SELECTION_TIMEOUT_MS = 90_000;
const MAX_CONVERSATION_BYTES = 1_048_576;
const MAX_RESULT_BYTES = 16_384;
const POLL_INTERVAL_MS = 100;

export class RoutingFailureExitError extends Error {
  readonly exitCode = 78;

  constructor(message: string) {
    super(message);
    this.name = 'RoutingFailureExitError';
  }
}

interface RoutingFailureRecord {
  schema: 'awf-routing-failure/v1';
  code: string;
  detail: string;
  retryable: boolean;
}

type RoutingResultRead =
  | { found: false }
  | { found: true; value: unknown };

function toRoutingFailureExit(message: string): RoutingFailureExitError {
  return new RoutingFailureExitError(message);
}

function routingRootForWorkDir(workDir: string): string {
  return path.join(getRealUserHome(), `.awf-routing-${path.basename(workDir)}`);
}

function parseMountSource(volume: string): string | undefined {
  const source = volume.split(':', 1)[0];
  return source && path.isAbsolute(source) ? source : undefined;
}

function normalizeForOverlap(candidate: string): string {
  const missing: string[] = [];
  let current = path.resolve(candidate);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    missing.unshift(path.basename(current));
    current = parent;
  }
  const resolved = fs.realpathSync.native(current);
  return path.resolve(resolved, ...missing);
}

function pathsOverlap(left: string, right: string): boolean {
  const leftToRight = path.relative(left, right);
  const rightToLeft = path.relative(right, left);
  return leftToRight === '' || rightToLeft === '' ||
    (!leftToRight.startsWith('..') && !path.isAbsolute(leftToRight)) ||
    (!rightToLeft.startsWith('..') && !path.isAbsolute(rightToLeft));
}

function assertRoutingRootDoesNotOverlapAgentMounts(config: WrapperConfig, root: string): void {
  const resolvedRoot = normalizeForOverlap(root);
  const translatedRootMount = applyHostPathPrefixToVolumes(
    [`${root}:/awf-routing-private:ro`],
    config.dockerHostPathPrefix,
  )[0];
  const daemonRoot = normalizeForOverlap(parseMountSource(translatedRootMount) ?? root);
  const visibleSources = [
    config.workDir,
    `${config.workDir}-chroot-home`,
    process.env.GITHUB_WORKSPACE || process.cwd(),
    '/tmp',
    ...(config.sessionStateDir ? [config.sessionStateDir] : []),
    ...(config.volumeMounts ?? []).map((volume) => parseMountSource(volume)).filter((value): value is string => !!value),
  ];

  for (const visible of visibleSources) {
    const resolvedVisible = normalizeForOverlap(visible);
    const translatedVisibleMount = applyHostPathPrefixToVolumes(
      [`${visible}:/awf-visible:ro`],
      config.dockerHostPathPrefix,
    )[0];
    const daemonVisible = normalizeForOverlap(parseMountSource(translatedVisibleMount) ?? visible);
    if (pathsOverlap(resolvedRoot, resolvedVisible) || pathsOverlap(daemonRoot, daemonVisible)) {
      throw new Error('Model routing private state overlaps an agent-visible path');
    }
  }
}

function assertRoutingHostSupported(config: WrapperConfig): void {
  if (process.platform !== 'linux') {
    throw new Error('Model routing requires a Linux host');
  }
  if (!config.enableApiProxy) {
    throw new Error('Model routing requires apiProxy.enabled');
  }
  if (config.keepContainers) {
    throw new Error('Model routing is not supported with --keep-containers');
  }
  if (config.enableDind || config.dind?.preStageDirs || config.dind?.stageEngineBinary) {
    throw new Error('Model routing is not supported with Docker-in-Docker');
  }
  if (config.dockerHostPathPrefix) {
    throw new Error('Model routing is not supported with split runner/Docker filesystems');
  }
  if (!runtimeUsesComposeAgent(config.containerRuntime)) {
    throw new Error('Model routing requires a Docker Compose managed agent');
  }
  const runtime = config.containerRuntime?.trim();
  if (runtime && runtime !== 'runc') {
    throw new Error('Model routing requires the default runc container runtime');
  }
  const exposingMount = findDockerSocketExposingMount(config);
  if (exposingMount) {
    throw new Error('Model routing is not supported when the agent can access the Docker socket');
  }
  const routerImage = resolveRuntimeImageFor(config, 'router');
  if (!isDigestPinnedImageReference(routerImage)) {
    throw new Error('Model routing requires container.images.router to be pinned by digest');
  }
}

function readPrivateConversation(source: string): unknown {
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      source,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW ?? 0),
    );
  } catch {
    throw new Error('The routing conversation is unavailable');
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error('The routing conversation must be a regular file');
    }
    if (stat.size > MAX_CONVERSATION_BYTES) {
      throw new Error(`The routing conversation exceeds ${MAX_CONVERSATION_BYTES} bytes`);
    }
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = fs.readSync(descriptor, buffer, offset, buffer.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== buffer.length) {
      throw new Error('The routing conversation is unavailable');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
      validateConversation(parsed);
    } catch {
      throw new Error('The routing conversation is invalid');
    }
    return parsed;
  } finally {
    fs.closeSync(descriptor);
  }
}

function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

function chownToSafeIdentity(target: string): void {
  const uid = Number.parseInt(getSafeHostUid(), 10);
  const gid = Number.parseInt(getSafeHostGid(), 10);
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) return;
  try {
    fs.chownSync(target, uid, gid);
  } catch {
    // Ownership repair is best-effort for non-root local runs. The proxy uses
    // the same safe identity, so directories created by that user already work.
  }
}

function writeJsonNoFollow(filename: string, value: unknown): void {
  const content = `${JSON.stringify(value)}\n`;
  const descriptor = fs.openSync(
    filename,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function stageRoutingConversation(config: WrapperConfig): ModelRoutingBootstrapState | undefined {
  if (!config.modelRouting) return undefined;

  assertRoutingHostSupported(config);
  const root = routingRootForWorkDir(config.workDir);
  assertRoutingRootDoesNotOverlapAgentMounts(config, root);

  const conversation = readPrivateConversation(config.modelRouting.task.conversationFile);
  const inputDir = path.join(root, 'input');
  const outputDir = path.join(root, 'output');
  fs.rmSync(root, { recursive: true, force: true });
  ensurePrivateDir(root);
  ensurePrivateDir(inputDir);
  ensurePrivateDir(outputDir);
  for (const dir of [root, inputDir, outputDir]) chownToSafeIdentity(dir);

  const inputFile = path.join(inputDir, 'conversation.json');
  try {
    writeJsonNoFollow(inputFile, conversation);
    chownToSafeIdentity(inputFile);
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }

  const state = Object.freeze({
    root,
    inputDir,
    outputDir,
    inputFile,
    containerInputFile: ROUTING_CONTAINER_CONVERSATION_FILE,
    containerOutputDir: ROUTING_CONTAINER_OUTPUT_DIR,
  });
  config.modelRoutingBootstrap = state;
  config.modelRouting = {
    ...config.modelRouting,
    task: { conversationFile: ROUTING_CONTAINER_CONVERSATION_FILE },
  };
  return state;
}

function readRoutingResultFile(filename: string): RoutingResultRead {
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      filename,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { found: false };
    throw toRoutingFailureExit('Model routing result could not be read');
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_RESULT_BYTES) {
      throw toRoutingFailureExit('Model routing result is invalid');
    }
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = fs.readSync(descriptor, buffer, offset, buffer.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    return { found: true, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)) };
  } catch (error) {
    if (error instanceof RoutingFailureExitError) throw error;
    throw toRoutingFailureExit('Model routing result is invalid');
  } finally {
    fs.closeSync(descriptor);
  }
}

function isFailureRecord(value: unknown): value is RoutingFailureRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.schema === 'awf-routing-failure/v1' &&
    typeof record.code === 'string' &&
    typeof record.detail === 'string' &&
    typeof record.retryable === 'boolean';
}

function isSelectionRecord(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const choice = record.choice as Record<string, unknown> | undefined;
  return record.schema === 'awf-routing-selection/v1' &&
    record.engine === 'copilot' &&
    record.provider === 'copilot' &&
    typeof record.wire_model === 'string' &&
    !!choice && typeof choice === 'object' &&
    typeof choice.id === 'string' &&
    typeof choice.model === 'string';
}

function routingFailureMessage(record: RoutingFailureRecord): string {
  return `Model routing failed (${record.code}): ${record.detail}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForRoutingSelection(
  state: ModelRoutingBootstrapState | undefined,
  timeoutMs = ROUTING_SELECTION_TIMEOUT_MS,
): Promise<void> {
  if (!state) return;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const failure = readRoutingResultFile(path.join(state.outputDir, 'failure.json'));
    if (failure.found) {
      if (isFailureRecord(failure.value)) throw toRoutingFailureExit(routingFailureMessage(failure.value));
      throw toRoutingFailureExit('Model routing failure result is invalid');
    }
    const selection = readRoutingResultFile(path.join(state.outputDir, 'selection.json'));
    if (selection.found) {
      if (!isSelectionRecord(selection.value)) throw toRoutingFailureExit('Model routing selection result is invalid');
      return;
    }
    if (Date.now() >= deadline) {
      throw toRoutingFailureExit('Model routing selection timed out');
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

export function verifyRoutingCompletion(state: ModelRoutingBootstrapState | undefined): void {
  if (!state) return;
  const failure = readRoutingResultFile(path.join(state.outputDir, 'failure.json'));
  if (failure.found) {
    if (isFailureRecord(failure.value)) throw toRoutingFailureExit(routingFailureMessage(failure.value));
    throw toRoutingFailureExit('Model routing failure result is invalid');
  }
  const runtimeFailure = readRoutingResultFile(path.join(state.outputDir, 'runtime-failure.json'));
  if (runtimeFailure.found) {
    if (isFailureRecord(runtimeFailure.value)) throw toRoutingFailureExit(routingFailureMessage(runtimeFailure.value));
    throw toRoutingFailureExit('Model routing runtime failure result is invalid');
  }
  const selection = readRoutingResultFile(path.join(state.outputDir, 'selection.json'));
  if (!selection.found || !isSelectionRecord(selection.value)) {
    throw toRoutingFailureExit('Model routing selection result is invalid');
  }
  const complete = readRoutingResultFile(path.join(state.outputDir, 'complete.json'));
  if (!complete.found || !complete.value || typeof complete.value !== 'object' || Array.isArray(complete.value) ||
      (complete.value as Record<string, unknown>).schema !== 'awf-routing-complete/v1') {
    throw toRoutingFailureExit('Model routing completion result is invalid');
  }
}

export function cleanupRoutingState(config: WrapperConfig): void {
  if (!config.keepContainers && config.modelRoutingBootstrap) {
    fs.rmSync(config.modelRoutingBootstrap.root, { recursive: true, force: true });
  }
}

/** @internal Exposed for focused unit tests. */
// ts-prune-ignore-next
export const routingBootstrapTestHelpers = {
  readPrivateConversation,
  readRoutingResultFile,
  routingRootForWorkDir,
  isSelectionRecord,
  isFailureRecord,
  pathsOverlap,
  normalizeForOverlap,
};
