import * as path from 'path';
import type {
  HostExecutorBackendResult, HostExecutorInvocationPlan, HostExecutorRunState,
} from '../enclave/host-executor-server';
import { HOST_EXECUTOR_MAX_RESULT_BYTES } from '../enclave/host-executor-protocol';
import { HostExecutorInvocationDiagnostics } from '../enclave/host-executor-diagnostics';
import { readBoundedEnclaveResult } from '../enclave/invocation-result';
import type { HostExecutorAgentPolicy, HostEnclaveExecutorManager } from './enclave-executor-types';
import type { HostEnclaveInvocationResources, InvocationCheck } from './host-enclave-executor-cleanup';
import { HostEnclaveInvocationEvidence, invocationOperationStage } from './host-enclave-executor-diagnostics';
import { HostEnclaveStderr } from './host-enclave-executor-stderr';
import type { HostEnclaveInvocationInterruption } from './host-enclave-execution-phases';
import { HostPreflightReporter, markHostPreflightError } from './host-preflight-progress';

export class HostEnclaveExecutionProgress {
  readonly diagnostic: HostExecutorInvocationDiagnostics;
  readonly report: HostPreflightReporter;
  readonly evidence: HostEnclaveInvocationEvidence;
  readonly stderr = new HostEnclaveStderr();
  guestWorkloadFailed = false;

  constructor(
    run: HostExecutorRunState,
    plan: HostExecutorInvocationPlan,
    debug: ConstructorParameters<typeof HostEnclaveInvocationEvidence>[2],
  ) {
    this.diagnostic = new HostExecutorInvocationDiagnostics(run, plan);
    this.report = new HostPreflightReporter(
      'host-invocation',
      this.diagnostic.publish,
      (failedReport, _id, error) => this.diagnostic.classifyFailure(failedReport, error),
    );
    this.evidence = new HostEnclaveInvocationEvidence(plan, this.diagnostic, debug);
  }

  readonly check = <T>(id: Parameters<HostPreflightReporter['check']>[0], operation: () => Promise<T> | T): Promise<T> => {
    const run = () => this.diagnostic.check(this.report, id, operation);
    return this.evidence.operations ? this.evidence.operations.check(invocationOperationStage(id), run) : run();
  };

  readonly cleanupOperation = <T>(operation: () => Promise<T>): Promise<T> =>
    this.evidence.operations ? this.evidence.operations.check('cleanup', operation, true) : operation();

  createCleanupCheck(): InvocationCheck {
    const cleanupReport = this.report.fork('host-invocation-cleanup');
    return (id, operation) => this.cleanupOperation(() => this.diagnostic.check(cleanupReport, id, operation));
  }
}

function filePath(directory: string, name: string): string {
  const result = path.join(directory, name);
  if (path.dirname(result) !== directory) throw new Error('Invalid enclave artifact path');
  return result;
}

export async function readHostEnclaveResult(
  resources: HostEnclaveInvocationResources,
  policy: HostExecutorAgentPolicy | undefined,
  progress: HostEnclaveExecutionProgress,
  interruption: HostEnclaveInvocationInterruption,
  executionResult: Awaited<ReturnType<HostEnclaveExecutorManager['execute']>>,
  signal: AbortSignal,
): Promise<HostExecutorBackendResult> {
  const { plan } = resources;
  const { diagnostic, report, evidence, check, cleanupOperation } = progress;
  diagnostic.milestone('guest-complete');
  evidence.exitCode = executionResult.exitCode;
  evidence.failure = executionResult.exitCode === 0 && executionResult.signal === null ? 'none' : 'workload-exit';
  if (interruption.timedOut || executionResult.timedOut) {
    diagnostic.fail(report, 'guest-execute', markHostPreflightError(
      new Error('Host executor invocation timed out'), 'invocation-timeout'));
    return { outcome: 'timeout' };
  }
  if (interruption.aborted || signal.aborted) {
    diagnostic.fail(report, 'guest-execute', markHostPreflightError(
      new Error('Host executor invocation was cancelled'), 'invocation-cancelled'));
    return { outcome: 'cancelled' };
  }
  if (executionResult.exitCode !== 0 || executionResult.signal !== null) {
    evidence.operations?.fail('workload-exit', undefined, false, 'workload-exit');
    diagnostic.fail(report, 'guest-execute', markHostPreflightError(
      new Error('Host executor guest command failed'), 'command-failed'));
    progress.guestWorkloadFailed = true;
    return { outcome: 'executor-failure' };
  }
  // Result reads require the VM to have stopped, but cleanup failures
  // must remain distinct from the invocation's original failure.
  const cleanupReport = report.fork('host-invocation-cleanup');
  await cleanupOperation(() => diagnostic.check(cleanupReport, 'manager-stop', () => interruption.race(resources.stopManager())));
  resources.managerStopped = true;
  await cleanupOperation(() => diagnostic.check(cleanupReport, 'manager-record', () => interruption.race(resources.manager!.completeCleanupRecord())));
  if (interruption.timedOut || interruption.aborted || signal.aborted) {
    return interruption.timedOut ? { outcome: 'timeout' } : { outcome: 'cancelled' };
  }
  const outputPath = filePath(filePath(plan.invocationHostDir, 'output'), 'out');
  const maxBytes = plan.executorKind === 'agent'
    ? policy?.maxOutputBytes ?? HOST_EXECUTOR_MAX_RESULT_BYTES
    : HOST_EXECUTOR_MAX_RESULT_BYTES;
  diagnostic.milestone('result-read-start');
  evidence.stage = 'result';
  evidence.failure = 'result-invalid';
  const resultValue = await check('result-read', () => interruption.race(readBoundedEnclaveResult(
    outputPath,
    plan.schema,
    maxBytes,
  )));
  diagnostic.milestone('result-read-complete');
  if (resultValue === undefined) {
    evidence.operations?.fail('output-validation', undefined, false, 'result-invalid');
    diagnostic.fail(report, 'result-read', markHostPreflightError(
      new Error('Host executor result is invalid'), 'result-invalid'));
    return { outcome: 'schema-failure' };
  }
  evidence.stage = 'complete';
  evidence.failure = 'none';
  return { outcome: 'success', result: resultValue };
}
