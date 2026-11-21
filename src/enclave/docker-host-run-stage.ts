import * as fs from 'fs';
import * as path from 'path';
import { serializeFiniteSchema } from '../bounded-execution/finite-schema';
import type {
  DockerHostContext, DockerHostInvocationStage, DockerHostAgentAuthority, DockerHostRunnerConfig,
} from './docker-host-context';
import type { DockerHostContainerOperations } from './docker-host-container';
import type { HostExecutorBackendResult } from './host-executor-server';
import { dockerHelperStorageTarget } from './docker-storage-helper';
import { ownDockerHostStorageFile } from './docker-host-storage';
import { isDockerHostSeedValid } from './docker-host-plan-validation';
import { buildDockerHostLaunchArgs, buildDockerHostLaunchConfig } from './docker-host-launch-args';

/* eslint-disable @typescript-eslint/no-require-imports */
const { DockerEnclaveRunner } = require('../../containers/enclave/agent-executor/docker-enclave-runner.js');
const { buildAgentTask } = require('../../containers/enclave/mcp-server/agent-executor.js');
/* eslint-enable @typescript-eslint/no-require-imports */

export interface DockerHostLaunch {
  storageTarget: string;
  authority: DockerHostAgentAuthority;
  config: DockerHostRunnerConfig;
  args: string[];
  debugSecrets: string[];
}

export async function prepareDockerHostRun(
  context: DockerHostContext, invocation: Omit<DockerHostInvocationStage, 'record'>,
): Promise<DockerHostLaunch | HostExecutorBackendResult> {
  const { plan, entry, signal, authorityState, debugCheck } = invocation;
  const { options, helperStorage } = context;
  const storageTarget = helperStorage
    ? dockerHelperStorageTarget(plan.runId, plan.entryId, plan.invocationId) : plan.invocationHostDir;
  let authority: DockerHostAgentAuthority = {};
  if (entry.executorKind === 'agent' && options.resolveAgentAuthority) {
    authorityState.attempted = plan.selector !== undefined;
    authority = await debugCheck('authority-handoff', () => options.resolveAgentAuthority!(plan, signal));
    authorityState.resolved = true;
  }
  else authorityState.diagnostic?.event('authority-handoff', 'not-applicable');
  if (signal.aborted) return { outcome: 'cancelled' };
  const config = buildDockerHostLaunchConfig(plan, entry, storageTarget, authority);
  if (!config) return { outcome: 'executor-failure' };
  if (!await isDockerHostSeedValid(plan, Boolean(config.dynamicEnabled), debugCheck)) return { outcome: 'executor-failure' };
  return {
    storageTarget, authority, config,
    ...buildDockerHostLaunchArgs(plan, entry, storageTarget, config, authority, options.publicDebug),
  };
}

function privateFile(
  directory: string, name: string, value: string, mode: 0o400 | 0o444 | 0o600 | 0o644 = 0o444,
): void {
  const target = path.join(directory, name);
  fs.writeFileSync(target, value, { flag: 'wx', mode });
  fs.chmodSync(target, mode);
}

async function stageDockerHostInvocationFiles(
  stage: DockerHostInvocationStage, launch: DockerHostLaunch, publicDebug: boolean | undefined,
): Promise<void> {
  const { record, entry, plan } = stage;
  const { config, authority } = launch;
  const stageFile = async (
    name: string, value: string, mode: 0o400 | 0o444 | 0o600 | 0o644 = 0o444,
    uid = entry.uid, gid = entry.gid,
  ) => {
    if (name === 'session.jsonl' && uid === entry.uid) {
      throw new Error('Enclave session transcript requires a separate supervisor identity');
    }
    privateFile(record.storageTarget, name, value, mode);
    if (mode !== 0o444) await ownDockerHostStorageFile(record.mount!, name, uid, gid);
  };
  await stageFile('out', '', 0o600);
  if (publicDebug) {
    await stageFile('stdout.log', '', 0o600);
    await stageFile('stderr.log', '', 0o600);
  }
  if (entry.executorKind === 'script') await stageFile('script.py', plan.payload);
  else {
    const task = buildAgentTask(plan.payload, {
      githubEnabled: Boolean(config.githubEnabled || config.dynamicEnabled),
      privateRepo: authority.repository,
    });
    if (Buffer.byteLength(task) > 64 * 1024) throw new Error('Docker enclave scoped task exceeds the audited input bound');
    await stageFile('task.txt', task);
    await stageFile('schema.json', JSON.stringify(serializeFiniteSchema(plan.schema)));
    await stageFile(
      'session.jsonl', '', 0o644, process.getuid?.() ?? 0, process.getgid?.() ?? 0,
    );
    const agentDirectory = path.join(record.storageTarget, 'agent');
    fs.mkdirSync(agentDirectory, { mode: 0o700 });
    fs.chmodSync(agentDirectory, 0o700);
    await ownDockerHostStorageFile(record.mount!, 'agent', entry.uid, entry.gid);
    if (config.githubEnabled) {
      if (!/^[A-Za-z0-9_-]{32,128}$/.test(authority.githubAgentId || '')) throw new Error('Invalid static GitHub enclave authority');
      await stageFile('github-agent-id', authority.githubAgentId!, 0o400);
    }
    if (config.dynamicEnabled) {
      if (!/^[\x21-\x7e]{16,512}$/.test(authority.githubBearer || '')) throw new Error('Invalid dynamic GitHub enclave authority');
      await stageFile('github-bearer', authority.githubBearer!, 0o400);
    }
  }
}

export async function runDockerHostWorkload(
  context: DockerHostContext, containers: DockerHostContainerOperations,
  stage: DockerHostInvocationStage, launch: DockerHostLaunch,
): Promise<number> {
  const { record, entry, signal, authorityState, debugCheck } = stage;
  const diagnostic = authorityState.diagnostic;
  await debugCheck('authority-handoff', () => stageDockerHostInvocationFiles(stage, launch, context.options.publicDebug));
  if (entry.executorKind === 'agent') {
    await debugCheck('network-isolation', () => new DockerEnclaveRunner(launch.config, {
      docker: { runDocker: (values: string[]) => context.docker(values) },
    }).assertNetworkIsolated());
  }
  const id = await debugCheck('workload-create', () => containers.createContainer(record, launch.args));
  if (record.publicDebug) {
    record.publicDebug.stage = 'execution';
    record.publicDebug.failure = 'execution-exception';
    context.journal.write(record);
  }
  const exitCode = await containers.runContainer(record, id, signal, () => { authorityState.launchedAt = Date.now(); },
    diagnostic, state => { authorityState.dockerState = state; });
  if (exitCode !== 0) diagnostic?.fail('workload-exit', undefined, false, 'workload-exit');
  if (record.publicDebug) {
    record.publicDebug.exitCode = exitCode;
    record.publicDebug.stage = exitCode === 0 ? 'result' : 'execution';
    record.publicDebug.failure = exitCode === 0 ? 'result-invalid' : 'workload-exit';
    record.publicDebug.dockerState = authorityState.dockerState;
    context.journal.write(record);
  }
  return exitCode;
}
