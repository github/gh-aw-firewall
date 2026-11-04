import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { WrapperConfig } from './types';
import { resolveLogPaths } from './log-paths';
import { writeFileNoFollow } from './fs-utils';
import { resolveRunnerVisibleHostPath } from './services/host-path-prefix';
import { logger } from './logger';
import {
  HarnessContext, HarnessObservationReport, HarnessProbe,
  selectHarness, unavailable, probeCommand, parseProbe, eligibilityEvidence,
} from './model-information-contract/harness-observation';
import { validateObservedCopilotHarness } from './commands/validators/api-proxy-validator';
import { supportsDockerHarnessObservation } from './docker-harness-observation';

const contexts = new WeakMap<WrapperConfig, HarnessContext>();
const OBSERVATION_FILE = 'harness-observation.json';

export function harnessContext(config: WrapperConfig): HarnessContext {
  let context = contexts.get(config);
  if (!context) {
    context = Object.freeze({
      environment: `${config.containerRuntime || 'docker'}:${randomUUID()}`,
      ...selectHarness(config.agentCommand),
    });
    contexts.set(config, context);
  }
  return context;
}

export function harnessProxyEnvironment(config: WrapperConfig): Record<string, string> {
  const context = harnessContext(config);
  return {
    AWF_HARNESS_ENVIRONMENT: context.environment,
    AWF_SELECTED_HARNESS: context.name || '',
    AWF_HARNESS_BINARY: context.binary || '',
  };
}

function publish(config: WrapperConfig, report: HarnessObservationReport): void {
  if (!config.enableApiProxy) return;
  const apiProxyLogs = resolveRunnerVisibleHostPath(
    resolveLogPaths(config).apiProxyLogs, config.dockerHostPathPrefix,
  );
  const filename = path.join(apiProxyLogs, OBSERVATION_FILE);
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    writeFileNoFollow(temporary, `${JSON.stringify(report)}\n`, 0o644);
    fs.renameSync(temporary, filename);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** Reset per-run evidence before the sidecar (or its routing controller) starts. */
export function prepareHarnessObservation(config: WrapperConfig): void {
  const context = harnessContext(config);
  publish(config, unavailable(context, !context.name ? 'selection_unavailable' :
    config.containerRuntime === 'cloud-hypervisor' || supportsDockerHarnessObservation(config)
      ? 'probe_pending' : 'runtime_probe_unsupported'));
}

export async function observeHarness(
  config: WrapperConfig, probe?: HarnessProbe,
): Promise<HarnessObservationReport> {
  const context = harnessContext(config);
  const selection = selectHarness(config.agentCommand);
  let report = unavailable(context, !selection ? 'selection_unavailable' : 'runtime_probe_unsupported');
  if (selection && (selection.name !== context.name || selection.binary !== context.binary)) {
    report = unavailable(context, 'selection_unavailable');
  } else if (selection && probe) {
    try {
      report = parseProbe(context, await probe(probeCommand(selection)));
    } catch {
      // Do not publish backend errors, which may contain argv or credentials.
      report = unavailable(context, 'probe_failed');
    }
  }
  if (report.status === 'unavailable') {
    const log = context.name ? logger.warn.bind(logger) : logger.debug.bind(logger);
    log(`Selected harness observation unavailable: ${report.reason}`);
  }
  publish(config, report);
  // The earlier offline validation runs before any actual guest exists. Recheck
  // concrete CLI selections here with the observed environment, never host PATH.
  if (context.name === 'copilot-cli') {
    validateObservedCopilotHarness(config,
      eligibilityEvidence(report, { provider: 'copilot', channel: 'copilot-cli' }));
  }
  return report;
}
