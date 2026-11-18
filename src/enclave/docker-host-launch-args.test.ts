import * as path from 'path';
import type { DockerHostAgentAuthority, DockerHostExecutorEntry, DockerHostRunnerConfig } from './docker-host-context';
import type { HostExecutorInvocationPlan } from './host-executor-server';
import {
  buildDockerHostLaunchArgs, buildDockerHostLaunchConfig, buildDockerHostStorageProbeArgs,
} from './docker-host-launch-args';

/* eslint-disable @typescript-eslint/no-require-imports */
const { deriveQueryContainerSpec } = require('../../containers/enclave/script-executor/script-runner-spec.js');
const { deriveEnclaveContainerSpec } = require('../../containers/enclave/agent-executor/enclave-runner-spec.js');
/* eslint-enable @typescript-eslint/no-require-imports */

const runId = 'a'.repeat(32);
const invocationId = 'b'.repeat(32);
const seedId = 'c'.repeat(32);
const storageTarget = path.join(process.cwd(), 'invocations', invocationId);
const plan: HostExecutorInvocationPlan = {
  runId, invocationId, entryId: 'script', executorKind: 'script', timeoutMs: 1000,
  requestHash: 'd'.repeat(64), admissionId: 'e'.repeat(32), schemaHash: 'f'.repeat(64),
  schema: { type: 'boolean' }, payload: 'pass', invocationHostDir: storageTarget,
  seedId, seedHostPath: path.join(process.cwd(), 'seeds', seedId),
};
const script: DockerHostExecutorEntry = {
  entryId: 'script', executorKind: 'script', hostWritableBytes: 4096, aggregateWritableBytes: 4096,
  config: {
    queryImage: 'trusted/script:custom', querySeccompPath: '/policy/script.json', queryUid: 65534, queryGid: 65534,
    queryMountDir: '/query', queryScriptPath: '/awf/query-script.py',
    memoryLimit: '768m', cpuLimit: '0.5', pidsLimit: 47, tmpfsLimit: '96m',
  },
};
const agent: DockerHostExecutorEntry = {
  ...script, entryId: 'agent', executorKind: 'agent',
  config: {
    enclaveImage: 'trusted/agent:custom', enclaveSeccompPath: '/policy/agent.json', enclaveUid: 65534, enclaveGid: 65534,
    enclaveMountDir: '/agent', enclaveSeedPath: '/awf/seed', enclaveTaskPath: '/awf/task.txt',
    enclaveSchemaPath: '/awf/schema.json', enclaveGithubBearerPath: '/run/awf-enclave-github/bearer',
    engine: 'copilot', profile: 'copilot', model: 'trusted-model', apiEndpoint: 'http://172.31.0.30:10002',
    network: 'awf-enclave-agent', memoryLimit: '768m', cpuLimit: '0.5', pidsLimit: 47, tmpfsLimit: '96m',
    timeoutSeconds: 120, maxOutputBytes: 8192,
  },
};
const agentPlan = { ...plan, entryId: 'agent', executorKind: 'agent' as const };

describe('Docker host launch configuration and arguments', () => {
  test('overrides host paths and labels without mutating trusted entry configuration', () => {
    const config = buildDockerHostLaunchConfig(plan, script, storageTarget, {});
    expect(config).toEqual({
      ...script.config, hostWorkDir: path.dirname(storageTarget), hostSeedsDir: path.dirname(plan.seedHostPath!),
      runLabelKey: 'awf.enclave.run', invocationLabelKey: 'awf.enclave.invocation',
      containerPrefix: 'awf-enclave-script-script',
      querySeccompPath: path.join(storageTarget, 'seccomp.json'), enclaveSeccompPath: path.join(storageTarget, 'seccomp.json'),
    });
    expect(script.config.querySeccompPath).toBe('/policy/script.json');
    expect(script.config.hostWorkDir).toBeUndefined();
  });

  test.each([
    [agent, { selector: 'owner/repo' }, {}],
    [{ ...agent, config: { ...agent.config, dynamicEnabled: true } }, {}, {}],
    [{ ...agent, config: { ...agent.config, dynamicEnabled: true } }, { selector: 'owner/repo' }, { repository: 'other/repo', githubBearer: 'test-bearer' }],
    [{ ...agent, config: { ...agent.config, dynamicEnabled: true } }, { selector: 'owner/repo' }, { repository: 'owner/repo' }],
  ] as [DockerHostExecutorEntry, Partial<HostExecutorInvocationPlan>, DockerHostAgentAuthority][])(
    'returns undefined for selector or authority mismatch %#', (entry, invocation, authority) => {
      expect(buildDockerHostLaunchConfig({ ...agentPlan, ...invocation }, entry, storageTarget, authority)).toBeUndefined();
    },
  );

  test('uses the audited dynamic binding checks and only binds admitted repository/read mode', () => {
    const entry = { ...agent, config: { ...agent.config, dynamicEnabled: true } };
    const invocation = { ...agentPlan, selector: 'owner/repo', seedId: undefined, seedHostPath: undefined };
    const authority: DockerHostAgentAuthority = { repository: 'owner/repo', githubBearer: 'test-bearer', readMode: 'live' };
    expect(buildDockerHostLaunchConfig(invocation, entry, storageTarget, authority)).toMatchObject({
      dynamicRepository: 'owner/repo', dynamicReadMode: 'live', hostSeedsDir: '',
    });
    expect(() => buildDockerHostLaunchConfig(invocation, entry, storageTarget, { ...authority, readMode: undefined }))
      .toThrow('not a canonical admitted repository and read mode');
  });

  test('preserves the full audited script vector except log driver and immutable seed bind', () => {
    const entry = { ...script, runtimeName: 'runsc' as const };
    const config = buildDockerHostLaunchConfig(plan, entry, storageTarget, {})!;
    const audited = deriveQueryContainerSpec({ config, runId, invocationId, runtimeName: entry.runtimeName }).launchArgs;
    const expected = [...audited];
    expected[expected.indexOf(`${storageTarget}/repo:/awf/seed:ro`)] = `${plan.seedHostPath}:/awf/seed:ro`;
    expected.splice(1, 0, '--log-driver', 'none');
    const { args } = buildDockerHostLaunchArgs(plan, entry, storageTarget, config, {}, false);
    expect(args).toEqual(expected);
    expect(args[args.indexOf('--entrypoint') + 1]).toBe('/usr/local/bin/run-enclave-script');
    expect(audited).toContain(`${storageTarget}/repo:/awf/seed:ro`);
  });

  test.each([false, true])('preserves the audited agent vector for dynamic=%s', dynamicEnabled => {
    const entry = { ...agent, config: { ...agent.config, dynamicEnabled } };
    const invocation = dynamicEnabled
      ? { ...agentPlan, selector: 'owner/repo', seedId: undefined, seedHostPath: undefined } : agentPlan;
    const authority: DockerHostAgentAuthority = { repository: 'owner/repo', githubBearer: 'test-bearer', readMode: 'pinned' };
    const config = buildDockerHostLaunchConfig(invocation, entry, storageTarget, authority)!;
    const expected = [...deriveEnclaveContainerSpec({ config, runId, invocationId, seedId: invocation.seedId }).launchArgs];
    expected.splice(1, 0, '--log-driver', 'none');
    const { args } = buildDockerHostLaunchArgs(invocation, entry, storageTarget, config, authority, false);
    expect(args).toEqual(expected);
    expect(args.some(value => value.endsWith(':/awf/seed:ro'))).toBe(!dynamicEnabled);
  });

  test.each([script, agent])('inserts public debug flags and stream mounts before the $executorKind image', entry => {
    const invocation = entry.executorKind === 'agent' ? agentPlan : plan;
    const config = buildDockerHostLaunchConfig(invocation, entry, storageTarget, {})!;
    const normal = buildDockerHostLaunchArgs(invocation, entry, storageTarget, config, {}, false).args;
    const { args } = buildDockerHostLaunchArgs(invocation, entry, storageTarget, config, {}, true);
    expect(args).toEqual([
      ...normal.slice(0, -1), '--env', 'AWF_ENCLAVE_DEBUG_PUBLIC=true',
      ...(entry.executorKind === 'agent' ? ['--env', 'AWF_ENCLAVE_AGENT_DEBUG_RAW_SESSION_LOGS=true'] : []),
      '-v', `${storageTarget}/stdout.log:/awf/stdout.log:rw`, '-v', `${storageTarget}/stderr.log:/awf/stderr.log:rw`,
      normal[normal.length - 1],
    ]);
  });

  test.each(['copilot', 'codex', 'claude'])('collects configuration, authority and generated %s credentials for redaction', engine => {
    const config: DockerHostRunnerConfig = {
      ...buildDockerHostLaunchConfig(agentPlan, agent, storageTarget, {})!,
      engine, apiKey: 'test-api-key', authorization: 'test-authorization',
      modelBudgetSecret: '1'.repeat(64), maxModelTokens: 123,
      tokenPath: '/not-secret', secretDirectory: '/not-secret-dir', tokenFile: '/not-secret-file',
      tokenBudget: 'not-secret-budget', tokenLimit: 'not-secret-limit', tokens: 'not-secret-tokens',
      credentialCount: 123,
    };
    const authority = { githubAgentId: 'test-agent-id', githubBearer: 'test-github-bearer' };
    const { args, debugSecrets } = buildDockerHostLaunchArgs(agentPlan, agent, storageTarget, config, authority, true);
    expect(debugSecrets).toEqual(expect.arrayContaining([
      'test-api-key', 'test-authorization', authority.githubAgentId, authority.githubBearer, config.modelBudgetSecret, '******',
    ]));
    for (const excluded of ['/not-secret', '/not-secret-dir', '/not-secret-file', 'not-secret-budget', 'not-secret-limit', 'not-secret-tokens', 123]) {
      expect(debugSecrets).not.toContain(excluded);
    }
    const generated = args.filter((value, i) => args[i - 1] === '--env'
      && /^(COPILOT_TOKEN|COPILOT_PROVIDER_BEARER_TOKEN|OPENAI_API_KEY|ANTHROPIC_AUTH_TOKEN)=/.test(value))
      .map(value => value.slice(value.indexOf('=') + 1));
    expect(generated.length).toBeGreaterThan(0);
    for (const value of generated) expect(debugSecrets).toContain(value);
    expect(args.join(' ')).not.toContain(authority.githubBearer);
    expect(args.join(' ')).not.toContain(config.modelBudgetSecret);
  });

  test.each(['script', 'agent'] as const)('builds the exact isolated %s storage probe vector without mutating launch arguments', executorKind => {
    const args = Object.freeze([
      'run', '--log-driver', 'none', '--name', 'workload', '--network', 'workload-network',
      '--read-only', '--env', 'AWF_ENCLAVE_DEBUG_PUBLIC=true',
      '-v', `${storageTarget}/out:/awf/out:rw`, '-v', `${plan.seedHostPath}:/awf/seed:ro`,
      '-v', `${storageTarget}/stdout.log:/awf/stdout.log:rw`, '--runtime', 'runsc',
      '--entrypoint', '/audited/entrypoint', 'trusted/image',
    ]);
    expect(buildDockerHostStorageProbeArgs(args, executorKind, storageTarget, 4096, { dev: 42, ino: 123 })).toEqual({
      args: [
        'run', '--log-driver', 'none', '--name', 'workload-probe', '--network', 'none',
        '--read-only', '--env', 'AWF_ENCLAVE_DEBUG_PUBLIC=true', '--runtime', 'runsc',
        '-v', `${storageTarget}:/awf/host-storage-probe:ro`,
        '--entrypoint', executorKind === 'script' ? '/usr/bin/python3' : '/usr/bin/env', 'trusted/image',
      ],
      command: [
        ...(executorKind === 'agent' ? ['python3'] : []), '-c',
        'import os; p="/awf/host-storage-probe"; s=os.stat(p); v=os.statvfs(p); ' +
          'assert s.st_dev==42 and s.st_ino==123 and v.f_blocks*v.f_frsize==4096',
      ],
    });
    expect(args).toContain(`${storageTarget}/out:/awf/out:rw`);
    expect(args[args.indexOf('--network') + 1]).toBe('workload-network');
    expect(args[args.indexOf('--entrypoint') + 1]).toBe('/audited/entrypoint');
  });
});
