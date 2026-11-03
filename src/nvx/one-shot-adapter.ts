import * as path from 'path';
import type { Writable } from 'stream';
import { WorkflowCommandFilter } from '../microvm/workflow-command-filter';
import { writeWithBackpressure } from '../stream-utils';
import type { NvxFilesystemBundle } from './filesystem-builder';
import type { NvxOneShotOutcome } from './outcome';
import type { NvxLiveMount } from './live-mount-policy';
import {
  buildNvxHostEnvironment,
  buildNvxKernelCommandLine,
  buildNvxOneShotArguments,
} from './one-shot-arguments';
import {
  assertMatchingExitCode,
  assertNewOutcomePath,
  readOutcome,
  verifyFilesystemBundle,
} from './one-shot-outcome';
import {
  runNvxProcess,
  signalExitCode,
  type NvxProcessRequest,
  type NvxProcessResult,
} from './one-shot-process';
import {
  assertNetworkPolicy,
  assertRegularFile,
  formatError,
  validateNvxExecutionRequest,
} from './one-shot-validation';

export {
  appendMountArguments,
  buildNvxKernelCommandLine,
  buildNvxOneShotArguments,
  nvxShareName,
  usesNvxAggregateMount,
} from './one-shot-arguments';
export {
  NVX_ONE_SHOT_CPU_PROFILE,
  validateNvxExecutionRequest,
} from './one-shot-validation';
export type { NvxProcessResult } from './one-shot-process';

const NVX_DEFAULT_RAW_TAIL_BYTES = 64 * 1024;

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
  readonly cpuProfile?: string;
  readonly mounts?: readonly NvxLiveMount[];
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

export interface NvxOneShotAdapterDependencies {
  runProcess(request: NvxProcessRequest): Promise<NvxProcessResult>;
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
      validateNvxExecutionRequest(request);
      buildNvxKernelCommandLine(request);
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
};

/**
 * Packaged `nvx-rs sandbox run` transport retained for contract tests.
 *
 * Direct OpenVMM launches reuse NvxPreparedExecution so validation, filtered
 * output, timeout/cancellation results, and structured outcome checks stay
 * identical while applying their own host confinement.
 */
export class NvxOneShotAdapter {
  constructor(
    private readonly dependencies: NvxOneShotAdapterDependencies = defaultDependencies,
  ) {}

  async execute(request: NvxOneShotExecutionRequest): Promise<NvxOneShotExecutionResult> {
    const nvxBinary = path.join(request.nvxRoot, 'bin', 'nvx-rs');
    await assertRegularFile(nvxBinary, 'NVX launcher');
    const outcomePath = path.join(request.filesystem.runDirectory, 'outcome.json');
    const execution = await NvxPreparedExecution.create(request, outcomePath);
    const processResult = await this.dependencies.runProcess({
      command: nvxBinary,
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

/** @internal Test-only access to process-group lifecycle behavior. */
// ts-prune-ignore-next
export const testHelpers = { runNvxProcess };

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
