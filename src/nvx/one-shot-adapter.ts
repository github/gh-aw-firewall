import { constants, createReadStream, promises as fs } from 'fs';
import { createHash } from 'crypto';
import * as path from 'path';
import { spawn } from 'child_process';
import type { Readable, Writable } from 'stream';
import { WorkflowCommandFilter } from '../microvm/workflow-command-filter';
import { writeWithBackpressure } from '../stream-utils';
import type {
  NvxFilesystemBundle,
  NvxLayerArtifact,
} from './filesystem-builder';
import {
  parseNvxOneShotOutcome,
  type NvxOneShotOutcome,
} from './outcome';

const NVX_MAX_OUTCOME_BYTES = 64 * 1024;
const NVX_DEFAULT_RAW_TAIL_BYTES = 64 * 1024;
const NVX_TERMINATION_GRACE_MS = 2_000;
const NVX_DEFAULT_WORKLOAD_ID = 65534;

export interface NvxOneShotNetworkPlan {
  readonly guestAddress: string;
  readonly proxyAddress?: string;
  readonly egressAllow?: readonly string[];
  readonly egressDeny?: readonly string[];
  readonly hostLoopbackForwards?: readonly string[];
}

export interface NvxOneShotExecutionRequest {
  readonly nvxRoot: string;
  readonly filesystem: NvxFilesystemBundle;
  readonly entrypoint: string;
  readonly args?: readonly string[];
  readonly hostname?: string;
  readonly workloadUid?: number;
  readonly workloadGid?: number;
  readonly memoryMaxBytes?: number;
  readonly pidsMax?: number;
  readonly memoryMib?: number;
  readonly timeoutMs?: number;
  readonly abortSignal?: AbortSignal;
  readonly network: NvxOneShotNetworkPlan;
  readonly stdout?: Writable;
  readonly stderr?: Writable;
  readonly rawTailBytes?: number;
}

export interface NvxOneShotExecutionResult {
  readonly exitCode: number;
  readonly category:
    | NvxOneShotOutcome['outcome']['category']
    | 'timeout'
    | 'cancelled'
    | 'signal';
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly outcome?: NvxOneShotOutcome;
  readonly rawStdoutTail: Buffer;
  readonly rawStderrTail: Buffer;
}

interface NvxProcessRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly abortSignal?: AbortSignal;
  onStdout(chunk: Buffer): Promise<void>;
  onStderr(chunk: Buffer): Promise<void>;
}

export interface NvxProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
}

export interface NvxOneShotAdapterDependencies {
  runProcess(request: NvxProcessRequest): Promise<NvxProcessResult>;
  pythonBinary: string;
}

export class NvxOneShotExecutionError extends Error {
  readonly cause?: unknown;

  constructor(
    message: string,
    readonly category: 'missing-outcome' | 'invalid-outcome' | 'outcome-mismatch',
    readonly rawStdoutTail: Buffer,
    readonly rawStderrTail: Buffer,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'NvxOneShotExecutionError';
    this.cause = cause;
  }
}

export class NvxPreparedExecution {
    private readonly stdoutTail: BoundedByteTail;
    private readonly stderrTail: BoundedByteTail;
    private readonly stdoutFilter = new WorkflowCommandFilter();
    private readonly stderrFilter = new WorkflowCommandFilter();

    private constructor(
      readonly request: NvxOneShotExecutionRequest,
      readonly outcomePath: string,
      rawTailBytes: number,
    ) {
      this.stdoutTail = new BoundedByteTail(rawTailBytes);
      this.stderrTail = new BoundedByteTail(rawTailBytes);
    }

    static async create(
      request: NvxOneShotExecutionRequest,
      outcomePath = path.join(request.filesystem.runDirectory, 'outcome.json'),
    ): Promise<NvxPreparedExecution> {
      validateRequest(request);
      await verifyFilesystemBundle(request.filesystem);
      await assertNewOutcomePath(outcomePath, request.filesystem.runDirectory);
      const rawTailBytes = request.rawTailBytes ?? NVX_DEFAULT_RAW_TAIL_BYTES;
      if (!Number.isSafeInteger(rawTailBytes) || rawTailBytes < 0) {
        throw new Error(`NVX raw output tail limit must be a non-negative integer: ${rawTailBytes}`);
      }
      return new NvxPreparedExecution(request, outcomePath, rawTailBytes);
    }

    async onStdout(chunk: Buffer): Promise<void> {
      this.stdoutTail.push(chunk);
      if (this.request.stdout) {
        await writeWithBackpressure(this.request.stdout, this.stdoutFilter.push(chunk));
      }
    }

    async onStderr(chunk: Buffer): Promise<void> {
      this.stderrTail.push(chunk);
      if (this.request.stderr) {
        await writeWithBackpressure(this.request.stderr, this.stderrFilter.push(chunk));
      }
    }

    async finish(processResult: NvxProcessResult): Promise<NvxOneShotExecutionResult> {
      if (this.request.stdout) {
        await writeWithBackpressure(this.request.stdout, this.stdoutFilter.finish());
      }
      if (this.request.stderr) {
        await writeWithBackpressure(this.request.stderr, this.stderrFilter.finish());
      }

      if (processResult.timedOut) {
        return {
          exitCode: 124,
          category: 'timeout',
          signal: processResult.signal,
          timedOut: true,
          rawStdoutTail: this.stdoutTail.value(),
          rawStderrTail: this.stderrTail.value(),
        };
      }
      if (processResult.cancelled) {
        return {
          exitCode: 130,
          category: 'cancelled',
          signal: processResult.signal,
          timedOut: false,
          rawStdoutTail: this.stdoutTail.value(),
          rawStderrTail: this.stderrTail.value(),
        };
      }
      if (processResult.exitCode === null) {
        return {
          exitCode: signalExitCode(processResult.signal),
          category: 'signal',
          signal: processResult.signal,
          timedOut: false,
          rawStdoutTail: this.stdoutTail.value(),
          rawStderrTail: this.stderrTail.value(),
        };
      }

      let outcome: NvxOneShotOutcome;
      try {
        outcome = await readOutcome(this.outcomePath);
      } catch (error) {
        const category = error instanceof Error &&
          error.message.includes('did not produce')
          ? 'missing-outcome'
          : 'invalid-outcome';
        throw new NvxOneShotExecutionError(
          formatError(error),
          category,
          this.stdoutTail.value(),
          this.stderrTail.value(),
          error,
        );
      }
      try {
        assertMatchingExitCode(processResult.exitCode, outcome);
        if (outcome.outcome.category !== 'vmm-failure') {
          assertNetworkPolicy(this.request.network, outcome);
        }
      } catch (error) {
        throw new NvxOneShotExecutionError(
          formatError(error),
          'outcome-mismatch',
          this.stdoutTail.value(),
          this.stderrTail.value(),
          error,
        );
      }
      return {
        exitCode: outcome.outcome.statusCode,
        category: outcome.outcome.category,
        signal: processResult.signal,
        timedOut: false,
        outcome,
        rawStdoutTail: this.stdoutTail.value(),
        rawStderrTail: this.stderrTail.value(),
      };
    }
}

const defaultDependencies: NvxOneShotAdapterDependencies = {
  runProcess: runNvxProcess,
  pythonBinary: '/usr/bin/python3',
};

/**
 * Legacy `nvx.py sandbox run` transport retained for contract tests.
 *
 * Direct OpenVMM launches reuse NvxPreparedExecution so validation, filtered
 * output, timeout/cancellation results, and structured outcome checks stay
 * identical without depending on the broken flat launcher artifact.
 */
export class NvxOneShotAdapter {
  constructor(
    private readonly dependencies: NvxOneShotAdapterDependencies = defaultDependencies,
  ) {}

  async execute(request: NvxOneShotExecutionRequest): Promise<NvxOneShotExecutionResult> {
    const nvxScript = path.join(request.nvxRoot, 'scripts', 'nvx.py');
    await assertRegularFile(nvxScript, 'NVX launcher');
    const outcomePath = path.join(request.filesystem.runDirectory, 'outcome.json');
    const execution = await NvxPreparedExecution.create(request, outcomePath);
    const processResult = await this.dependencies.runProcess({
      command: this.dependencies.pythonBinary,
      args: buildNvxOneShotArguments(request, outcomePath),
      cwd: request.nvxRoot,
      env: buildNvxHostEnvironment(request.filesystem.runDirectory),
      timeoutMs: request.timeoutMs,
      abortSignal: request.abortSignal,
      onStdout: (chunk) => execution.onStdout(chunk),
      onStderr: (chunk) => execution.onStderr(chunk),
    });
    return execution.finish(processResult);
  }
}

export function buildNvxOneShotArguments(
  request: NvxOneShotExecutionRequest,
  outcomePath: string,
): readonly string[] {
  const uid = request.workloadUid ?? NVX_DEFAULT_WORKLOAD_ID;
  const gid = request.workloadGid ?? NVX_DEFAULT_WORKLOAD_ID;
  const args = [
    path.join('scripts', 'nvx.py'),
    'sandbox',
    'run',
  ];
  for (const layer of orderedLayers(request.filesystem.layers)) {
    args.push('--layer', `${layer.role},${layer.path},${layer.uuid}`);
  }
  args.push(
    '--scratch', request.filesystem.scratch.path,
    '--entrypoint', request.entrypoint,
  );
  for (const argument of request.args ?? []) args.push(`--arg=${argument}`);
  args.push(
    '--hostname', request.hostname ?? 'awf-nvx',
    '--workload-user', `${uid}:${gid}`,
  );
  if (request.memoryMaxBytes !== undefined) {
    args.push('--memory-max', String(request.memoryMaxBytes));
  }
  if (request.pidsMax !== undefined) args.push('--pids-max', String(request.pidsMax));
  args.push(
    '--memory-mib', String(request.memoryMib ?? 512),
    '--hypervisor', 'kvm',
    '--net', request.network.guestAddress,
    '--network-profile', 'portable',
    '--network-egress', 'deny',
    '--network-ingress', 'deny',
  );
  for (const rule of request.network.egressAllow ?? []) {
    args.push('--network-egress-allow', rule);
  }
  for (const rule of request.network.egressDeny ?? []) {
    args.push('--network-egress-deny', rule);
  }
  const forwards = request.network.hostLoopbackForwards ?? [];
  args.push('--host-loopback', forwards.length > 0 ? 'allow' : 'deny');
  if (request.network.proxyAddress !== undefined) {
    args.push('--network-proxy', request.network.proxyAddress);
  }
  for (const forward of forwards) args.push('--host-loopback-forward', forward);
  args.push('--outcome-report', outcomePath);
  return args;
}

async function verifyFilesystemBundle(bundle: NvxFilesystemBundle): Promise<void> {
  const runDirectory = path.resolve(bundle.runDirectory);
  const runDirectoryStat = await fs.lstat(runDirectory);
  if (!runDirectoryStat.isDirectory() || runDirectoryStat.isSymbolicLink()) {
    throw new Error(`NVX run directory must be a real directory: ${runDirectory}`);
  }
  if ((runDirectoryStat.mode & 0o077) !== 0) {
    throw new Error('NVX run directory must not be accessible to group or other users');
  }
  if (bundle.layers.length < 1 || bundle.layers.length > 3) {
    throw new Error('NVX filesystem bundle must contain one to three layers');
  }
  const roles = new Set<string>();
  for (const layer of orderedLayers(bundle.layers)) {
    if (layer.role !== 'distro' && layer.role !== 'runtime' && layer.role !== 'custom') {
      throw new Error(`Unsupported NVX layer role: ${String(layer.role)}`);
    }
    if (roles.has(layer.role)) throw new Error(`Duplicate NVX layer role: ${layer.role}`);
    roles.add(layer.role);
    assertContained(runDirectory, layer.path, `NVX ${layer.role} layer`);
    if (path.resolve(layer.path) !== path.join(runDirectory, `${layer.role}.erofs`)) {
      throw new Error(`NVX ${layer.role} layer has an unexpected artifact path`);
    }
    assertSafeDiskPath(layer.path);
    const stat = await assertRegularFile(layer.path, `NVX ${layer.role} layer`);
    if ((stat.mode & 0o777) !== 0o400) {
      throw new Error(`NVX ${layer.role} layer image must have mode 0400`);
    }
    assertUuid(layer.uuid, `NVX ${layer.role} layer UUID`);
    assertSha256(layer.sha256, `NVX ${layer.role} layer digest`);
    assertSha256(
      layer.sourceManifestSha256,
      `NVX ${layer.role} source manifest digest`,
    );
    const digest = await sha256File(layer.path);
    if (digest !== layer.sha256) {
      throw new Error(`NVX ${layer.role} layer digest changed after preparation`);
    }
  }
  assertContained(runDirectory, bundle.scratch.path, 'NVX scratch image');
  if (path.resolve(bundle.scratch.path) !== path.join(runDirectory, 'scratch.ext4')) {
    throw new Error('NVX scratch image has an unexpected artifact path');
  }
  assertSafeDiskPath(bundle.scratch.path);
  assertUuid(bundle.scratch.uuid, 'NVX scratch UUID');
  const scratch = await assertRegularFile(bundle.scratch.path, 'NVX scratch image');
  if (scratch.size !== bundle.scratch.sizeBytes) {
    throw new Error('NVX scratch image size changed after preparation');
  }
  if ((scratch.mode & 0o077) !== 0) {
    throw new Error('NVX scratch image must not be accessible to group or other users');
  }
  if (path.resolve(bundle.manifestPath) !== path.join(runDirectory, 'manifest.json')) {
    throw new Error('NVX filesystem manifest has an unexpected artifact path');
  }
  const manifestStat = await assertRegularFile(
    bundle.manifestPath,
    'NVX filesystem manifest',
  );
  if ((manifestStat.mode & 0o777) !== 0o400) {
    throw new Error('NVX filesystem manifest must have mode 0400');
  }
  if (manifestStat.size < 1 || manifestStat.size > NVX_MAX_OUTCOME_BYTES) {
    throw new Error('NVX filesystem manifest has an invalid size');
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(await fs.readFile(bundle.manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`NVX filesystem manifest is invalid: ${formatError(error)}`);
  }
  const expectedManifest = {
    schemaVersion: 1,
    sourceDateEpoch: bundle.sourceDateEpoch,
    layers: orderedLayers(bundle.layers).map((layer) => ({
      role: layer.role,
      file: path.basename(layer.path),
      uuid: layer.uuid,
      sha256: layer.sha256,
      sourceManifestSha256: layer.sourceManifestSha256,
      sourceEntries: layer.sourceEntries,
      excludedPaths: layer.excludedPaths,
    })),
    scratch: {
      file: path.basename(bundle.scratch.path),
      uuid: bundle.scratch.uuid,
      sizeBytes: bundle.scratch.sizeBytes,
      uid: bundle.scratch.uid,
      gid: bundle.scratch.gid,
    },
  };
  if (canonicalJson(manifest) !== canonicalJson(expectedManifest)) {
    throw new Error('NVX filesystem manifest does not match the prepared artifacts');
  }
}

function validateRequest(request: NvxOneShotExecutionRequest): void {
  if (request.entrypoint.includes('\0') || !request.entrypoint.startsWith('/')) {
    throw new Error('NVX entrypoint must be an absolute path without NUL bytes');
  }
  if (/\s/.test(request.entrypoint)) {
    throw new Error('NVX entrypoint must not contain whitespace');
  }
  for (const argument of request.args ?? []) {
    if (!argument || /\s/.test(argument) || argument.includes('\0')) {
      throw new Error('NVX one-shot arguments must be nonempty and contain no whitespace');
    }
  }
  const hostname = request.hostname ?? 'awf-nvx';
  if (
    hostname.length < 1 ||
    hostname.length > 63 ||
    hostname.startsWith('-') ||
    hostname.endsWith('-') ||
    !/^[a-z0-9-]+$/.test(hostname)
  ) {
    throw new Error(`Invalid NVX hostname: ${hostname}`);
  }
  const workloadUid = request.workloadUid ?? NVX_DEFAULT_WORKLOAD_ID;
  const workloadGid = request.workloadGid ?? NVX_DEFAULT_WORKLOAD_ID;
  assertPositiveInteger(workloadUid, 'NVX workload UID');
  assertPositiveInteger(workloadGid, 'NVX workload GID');
  if (
    request.filesystem.scratch.uid !== workloadUid ||
    request.filesystem.scratch.gid !== workloadGid
  ) {
    throw new Error(
      `NVX scratch owner ${request.filesystem.scratch.uid}:${request.filesystem.scratch.gid} ` +
      `must match workload identity ${workloadUid}:${workloadGid}`,
    );
  }
  assertOptionalPositiveInteger(request.memoryMaxBytes, 'NVX memory limit');
  assertOptionalPositiveInteger(request.pidsMax, 'NVX process limit');
  assertOptionalPositiveInteger(request.memoryMib, 'NVX guest memory');
  assertOptionalPositiveInteger(request.timeoutMs, 'NVX timeout');
  assertIpv4Cidr(request.network.guestAddress, 'NVX guest network address');
  if (request.network.proxyAddress !== undefined) {
    assertIpv4Endpoint(request.network.proxyAddress, 'NVX network proxy address');
  }
  for (const value of [
    ...(request.network.egressAllow ?? []),
    ...(request.network.egressDeny ?? []),
    ...(request.network.hostLoopbackForwards ?? []),
  ]) {
    if (!value || value.includes('\0') || /\s/.test(value)) {
      throw new Error(`Invalid NVX network rule: ${value}`);
    }
  }
}

function orderedLayers(layers: readonly NvxLayerArtifact[]): readonly NvxLayerArtifact[] {
  const order = new Map([
    ['distro', 0],
    ['runtime', 1],
    ['custom', 2],
  ]);
  return [...layers].sort((left, right) =>
    (order.get(left.role) ?? Number.MAX_SAFE_INTEGER) -
    (order.get(right.role) ?? Number.MAX_SAFE_INTEGER)
  );
}

async function readOutcome(outcomePath: string): Promise<NvxOneShotOutcome> {
  let handle;
  try {
    handle = await fs.open(
      outcomePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('NVX one-shot execution did not produce a structured outcome report');
    }
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error(`NVX outcome report must be a regular file: ${outcomePath}`);
    }
    throw error;
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error(`NVX outcome report must be a regular file: ${outcomePath}`);
    }
    if (stat.size < 1 || stat.size > NVX_MAX_OUTCOME_BYTES) {
      throw new Error(`NVX outcome report size must be 1-${NVX_MAX_OUTCOME_BYTES} bytes`);
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new Error('NVX outcome report must not be accessible to group or other users');
    }
    const contents = await handle.readFile();
    if (contents.length < 1 || contents.length > NVX_MAX_OUTCOME_BYTES) {
      throw new Error(`NVX outcome report size must be 1-${NVX_MAX_OUTCOME_BYTES} bytes`);
    }
    return parseNvxOneShotOutcome(contents.toString('utf8'));
  } finally {
    await handle.close();
  }
}

async function assertNewOutcomePath(outcomePath: string, runDirectory: string): Promise<void> {
  assertContained(runDirectory, outcomePath, 'NVX outcome report');
  const parent = await fs.lstat(path.dirname(outcomePath));
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw new Error('NVX outcome report parent must be a real directory');
  }
  try {
    await fs.lstat(outcomePath);
    throw new Error(`NVX outcome report already exists: ${outcomePath}`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw error;
  }
}

function assertMatchingExitCode(
  wrapperExitCode: number,
  outcome: NvxOneShotOutcome,
): void {
  if (wrapperExitCode !== outcome.outcome.statusCode) {
    throw new Error(
      `NVX wrapper exit ${wrapperExitCode} does not match structured outcome ` +
      `${outcome.outcome.category}:${outcome.outcome.statusCode}`,
    );
  }
}

function buildNvxHostEnvironment(runDirectory: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    PYTHONUNBUFFERED: '1',
    TMPDIR: runDirectory,
  };
  return environment;
}

async function runNvxProcess(request: NvxProcessRequest): Promise<NvxProcessResult> {
  const child = spawn(request.command, [...request.args], {
    cwd: request.cwd,
    env: request.env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdoutPump = pump(child.stdout, request.onStdout);
  const stderrPump = pump(child.stderr, request.onStderr);
  let timedOut = false;
  let cancelled = false;
  let forceKillTimer: NodeJS.Timeout | undefined;
  let pendingExit: { exitCode: number | null; signal: NodeJS.Signals | null } | undefined;
  let resolveCompletion!: (result: NvxProcessResult) => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<NvxProcessResult>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => {
      clearTimeout(timeout);
      pendingExit = { exitCode, signal };
      if (forceKillTimer === undefined) {
        resolveCompletion({ exitCode, signal, timedOut, cancelled });
      }
    });
  });
  const terminate = (reason: 'timeout' | 'cancelled'): void => {
    if (timedOut || cancelled) return;
    if (reason === 'timeout') timedOut = true;
    else cancelled = true;
    const terminationError = killProcessTree(
      child.pid,
      'SIGTERM',
      () => child.kill('SIGTERM'),
    );
    if (terminationError) {
      rejectCompletion(terminationError);
      return;
    }
    forceKillTimer = setTimeout(() => {
      forceKillTimer = undefined;
      void forceKill();
    }, NVX_TERMINATION_GRACE_MS);
  };
  const forceKill = async (): Promise<void> => {
    const forceKillError = pendingExit
      ? await killExitedProcessGroup(child.pid, 'SIGKILL')
      : killProcessTree(child.pid, 'SIGKILL', () => child.kill('SIGKILL'));
    if (forceKillError) {
      rejectCompletion(forceKillError);
    } else if (pendingExit) {
      // Keep escalation active after the launcher exits so descendants cannot survive.
      resolveCompletion({
        exitCode: pendingExit.exitCode,
        signal: pendingExit.signal,
        timedOut,
        cancelled,
      });
    }
  };
  const timeout = request.timeoutMs === undefined
    ? undefined
    : setTimeout(() => terminate('timeout'), request.timeoutMs);
  const onAbort = (): void => terminate('cancelled');
  request.abortSignal?.addEventListener('abort', onAbort, { once: true });
  if (request.abortSignal?.aborted) onAbort();
  try {
    const result = await completion;
    await Promise.all([stdoutPump, stderrPump]);
    return result;
  } finally {
    clearTimeout(timeout);
    clearTimeout(forceKillTimer);
    request.abortSignal?.removeEventListener('abort', onAbort);
  }
}

/** @internal Test-only access to process-group lifecycle behavior. */
// ts-prune-ignore-next
export const testHelpers = { runNvxProcess };

async function pump(
  source: Readable | null,
  destination: (chunk: Buffer) => Promise<void>,
): Promise<void> {
  if (!source) return;
  for await (const chunk of source) {
    await destination(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
}

function killProcessTree(
  pid: number | undefined,
  signal: NodeJS.Signals,
  fallback: () => boolean,
): Error | undefined {
  if (pid === undefined) return new Error('NVX process has no PID');
  try {
    if (process.platform === 'win32') {
      if (!fallback()) return new Error(`Failed to signal NVX process with ${signal}`);
    } else {
      process.kill(-pid, signal);
    }

    return undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return undefined;
    try {
      if (fallback()) return undefined;
    } catch (fallbackError) {
      return new Error(
        `Failed to signal NVX process group with ${signal}: ${formatError(fallbackError)}`,
      );
    }
    return new Error(
      `Failed to signal NVX process group with ${signal}: ${formatError(error)}`,
    );
  }
}

async function killExitedProcessGroup(
  pgid: number | undefined,
  signal: NodeJS.Signals,
): Promise<Error | undefined> {
  if (pgid === undefined) return new Error('NVX process has no PID');
  try {
    for (const entry of await fs.readdir('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = await fs.readFile(`/proc/${entry}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        if (fields[2] === String(pgid)) process.kill(Number(entry), signal);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ESRCH') throw error;
      }
    }
    return undefined;
  } catch (error) {
    return new Error(
      `Failed to signal exited NVX process group with ${signal}: ${formatError(error)}`,
    );
  }
}

class BoundedByteTail {
  private bytes = Buffer.alloc(0);

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    if (this.limit === 0) return;
    const combined = this.bytes.length === 0 ? chunk : Buffer.concat([this.bytes, chunk]);
    this.bytes = combined.length <= this.limit
      ? Buffer.from(combined)
      : Buffer.from(combined.subarray(combined.length - this.limit));
  }

  value(): Buffer {
    return Buffer.from(this.bytes);
  }
}

async function assertRegularFile(filePath: string, label: string) {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file: ${filePath}`);
  }
  return stat;
}

function assertSafeDiskPath(filePath: string): void {
  if (filePath.includes(',') || filePath.includes(';') || filePath.includes('\0')) {
    throw new Error(`NVX disk path contains an unsupported delimiter: ${filePath}`);
  }
}

function assertContained(root: string, candidate: string, label: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes ${root}: ${candidate}`);
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function assertOptionalPositiveInteger(value: number | undefined, label: string): void {
  if (value !== undefined) assertPositiveInteger(value, label);
}

function assertUuid(value: string, label: string): void {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      value,
    )
  ) {
    throw new Error(`${label} must be a canonical lowercase UUID`);
  }
}

function assertSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  switch (signal) {
    case 'SIGHUP': return 129;
    case 'SIGINT': return 130;
    case 'SIGQUIT': return 131;
    case 'SIGKILL': return 137;
    case 'SIGTERM': return 143;
    default: return 128;
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function assertNetworkPolicy(
  requested: NvxOneShotNetworkPlan,
  outcome: NvxOneShotOutcome,
): void {
  const expectedHostLoopback = (requested.hostLoopbackForwards?.length ?? 0) > 0
    ? 'allow'
    : 'deny';
  const expectedAllowRules = requested.egressAllow?.length ?? 0;
  const expectedDenyRules = requested.egressDeny?.length ?? 0;
  if (
    outcome.networkPolicy.status !== 'applied' ||
    outcome.networkPolicy.statusCode !== 0 ||
    outcome.networkPolicy.mode !== 'rules' ||
    outcome.networkPolicy.allowRuleCount !== expectedAllowRules ||
    outcome.networkPolicy.denyRuleCount !== expectedDenyRules ||
    outcome.networkPolicy.hostLoopback !== expectedHostLoopback
  ) {
    throw new Error(
      'NVX structured network policy does not match the requested fail-closed policy',
    );
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertIpv4Cidr(value: string, label: string): void {
  const [address, prefix, ...extra] = value.split('/');
  if (
    extra.length > 0 ||
    !isIpv4Address(address) ||
    prefix === undefined ||
    !Number.isInteger(Number(prefix)) ||
    Number(prefix) < 0 ||
    Number(prefix) > 32
  ) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

function assertIpv4Endpoint(value: string, label: string): void {
  const separator = value.lastIndexOf(':');
  const address = value.slice(0, separator);
  const port = Number(value.slice(separator + 1));
  if (
    separator < 1 ||
    !isIpv4Address(address) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

function isIpv4Address(value: string): boolean {
  const octets = value.split('.');
  return octets.length === 4 && octets.every((octet) => {
    if (!/^\d{1,3}$/.test(octet)) return false;
    const numeric = Number(octet);
    return numeric >= 0 && numeric <= 255 && String(numeric) === octet;
  });
}
