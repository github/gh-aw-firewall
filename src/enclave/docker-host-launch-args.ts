import * as path from 'path';
import type { DockerHostAgentAuthority, DockerHostExecutorEntry, DockerHostRunnerConfig } from './docker-host-context';
import type { HostExecutorInvocationPlan } from './host-executor-server';

/* eslint-disable @typescript-eslint/no-require-imports */
const { deriveQueryContainerSpec } = require('../../containers/enclave/script-executor/script-runner-spec.js');
const { deriveEnclaveContainerSpec, withDynamicBinding } = require('../../containers/enclave/agent-executor/enclave-runner-spec.js');
/* eslint-enable @typescript-eslint/no-require-imports */

export function buildDockerHostLaunchConfig(
  plan: HostExecutorInvocationPlan, entry: DockerHostExecutorEntry, storageTarget: string, authority: DockerHostAgentAuthority,
): DockerHostRunnerConfig | undefined {
  const config: DockerHostRunnerConfig = {
    ...entry.config,
    hostWorkDir: path.dirname(storageTarget),
    hostSeedsDir: plan.seedHostPath ? path.dirname(plan.seedHostPath) : '',
    runLabelKey: 'awf.enclave.run', invocationLabelKey: 'awf.enclave.invocation',
    containerPrefix: `awf-enclave-${entry.executorKind}-${entry.entryId}`,
    querySeccompPath: path.join(storageTarget, 'seccomp.json'),
    enclaveSeccompPath: path.join(storageTarget, 'seccomp.json'),
  };
  if (entry.executorKind === 'agent') {
    if (Boolean(config.dynamicEnabled) !== (plan.selector !== undefined)) return undefined;
    if (config.dynamicEnabled) {
      if (authority.repository !== plan.selector || !authority.githubBearer) return undefined;
      Object.assign(config, withDynamicBinding(config, { repository: authority.repository, readMode: authority.readMode }));
    }
  }
  return config;
}

export function buildDockerHostLaunchArgs(
  plan: HostExecutorInvocationPlan, entry: DockerHostExecutorEntry, storageTarget: string,
  config: DockerHostRunnerConfig, authority: DockerHostAgentAuthority, publicDebug: boolean | undefined,
): { args: string[]; debugSecrets: string[] } {
  const derived = entry.executorKind === 'script'
    ? deriveQueryContainerSpec({ config, runId: plan.runId, invocationId: plan.invocationId, runtimeName: entry.runtimeName })
    : deriveEnclaveContainerSpec({ config, runId: plan.runId, invocationId: plan.invocationId, seedId: plan.seedId, runtimeName: entry.runtimeName });
  const args: string[] = [...derived.launchArgs];
  // Retain the audited script entrypoint, mounting the immutable seed directly
  // instead of making an unbounded host-side seed copy.
  if (entry.executorKind === 'script') {
    const source = `${storageTarget}/repo:/awf/seed:ro`;
    args[args.indexOf(source)] = `${plan.seedHostPath}:/awf/seed:ro`;
  }
  args.splice(1, 0, '--log-driver', 'none');
  const credential = (key: string, value: unknown): value is string => typeof value === 'string'
    && /secret|token|bearer|authorization|api.?key/i.test(key)
    && !/tokens|path|directory|file|budget|limit/i.test(key);
  const debugSecrets = Object.entries(config).filter(([key, value]) => credential(key, value))
    .map(([, value]) => value as string);
  debugSecrets.push(
    authority.githubAgentId || '', authority.githubBearer || '',
    config.modelBudgetSecret as string || '', '******',
  );
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--env') {
      const value = args[i + 1] || '';
      const at = value.indexOf('=');
      const contents = value.slice(at + 1);
      if (at > 0 && credential(value.slice(0, at), contents)) debugSecrets.push(contents);
    }
  }
  if (publicDebug) {
    args.splice(args.length - 1, 0, '--env', 'AWF_ENCLAVE_DEBUG_PUBLIC=true',
      ...(entry.executorKind === 'agent' ? ['--env', 'AWF_ENCLAVE_AGENT_DEBUG_RAW_SESSION_LOGS=true'] : []),
      '-v', `${storageTarget}/stdout.log:/awf/stdout.log:rw`,
      '-v', `${storageTarget}/stderr.log:/awf/stderr.log:rw`);
  }
  return { args, debugSecrets };
}

export function buildDockerHostStorageProbeArgs(
  args: readonly string[], executorKind: DockerHostExecutorEntry['executorKind'], storageTarget: string,
  storageBytes: number, stat: { dev: number; ino: number },
): { args: string[]; command: string[] } {
  const probeArgs = [...args];
  const bindArgs: string[] = [];
  for (let i = 0; i < probeArgs.length; i++) {
    if (probeArgs[i] === '-v') { i++; continue; }
    bindArgs.push(probeArgs[i]);
  }
  bindArgs[bindArgs.indexOf('--network') + 1] = 'none';
  bindArgs[bindArgs.indexOf('--name') + 1] += '-probe';
  bindArgs[bindArgs.indexOf('--entrypoint') + 1] = executorKind === 'script' ? '/usr/bin/python3' : '/usr/bin/env';
  bindArgs.splice(bindArgs.length - 3, 0, '-v', `${storageTarget}:/awf/host-storage-probe:ro`);
  const command = [...(executorKind === 'agent' ? ['python3'] : []), '-c', 'import os; p="/awf/host-storage-probe"; s=os.stat(p); v=os.statvfs(p); ' +
    `assert s.st_dev==${stat.dev} and s.st_ino==${stat.ino} and v.f_blocks*v.f_frsize==${storageBytes}`];
  return { args: bindArgs, command };
}
