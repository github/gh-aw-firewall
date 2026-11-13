'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('util');
const { HOST_EXECUTOR_DEFAULT_JOURNAL_DIRECTORY } = require('../../../dist/enclave/host-executor-journal');
const { FAILURE_STAGES, SENTINEL_PREFIX } = require('./constants');
const {
  requestMcp, assertProfileTools, parsePublicToolResult, assertExpectedToolResult,
  acceptanceCheck, assertCanonicalToolError, mcpFailure, assertProfileInitialize,
} = require('./mcp-client');
const {
  buildScriptGuestProbe, buildScopedGithubGuestProbe, buildAgentGuestProbe,
  buildAgentEnospcProbe, buildConstantObjectSchema, buildEnospcProbeScript, buildOomProbeScript,
} = require('./guest-probes');
const { waitForVmCleanup, waitForPrimaryVmReadiness } = require('./vm-readiness');
const {
  resourceRecords, waitForInvocationRecord, waitForPath, waitForInvocationOutcome,
  withCrashRecoveryCleanup, readCrashRecoveryBaseline, findProcessForSocket,
  killAwfForRecovery, readRecoveredInvocation, assertRecoveredInvocation, assertNoSuccessfulResult,
} = require('./crash-recovery');
const { toAwfConfig, makeConfig, stopAwf } = require('./fixtures');
const { waitForBroker, waitForHostGatewayReadiness, failedSpawns } = require('./startup-evidence');
const { assertNoSentinelLeak } = require('./diagnostic-files');

async function runMcpRouteScenario(context) {
  context.failureContext.stage = FAILURE_STAGES.MCP_ROUTE;
  const initialized = await requestMcp(
    context.endpoint, context.gatewayKey, 1, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'awf-live-enclave-conformance', version: '1.0.0' },
    },
  );
  if (initialized?.result?.serverInfo?.name !== 'awmg-awf-enclave') {
    throw new Error('Public enclave MCP initialize did not route through the live broker');
  }
  const tools = await requestMcp(context.endpoint, context.gatewayKey, 2, 'tools/list', {});
  assertProfileTools(tools, 'combined');
}

async function runScriptScenario(context) {
  context.failureContext.stage = FAILURE_STAGES.SCRIPT;
  context.sentinel = `${SENTINEL_PREFIX}${crypto.randomBytes(12).toString('hex')}`;
  context.scriptProbe = buildScriptGuestProbe();
  context.python = [
    'import errno, json, os, re, resource, socket, sys',
    `print(${JSON.stringify(context.sentinel)})`,
    `print(${JSON.stringify(context.sentinel)}, file=sys.stderr)`,
    'status = open("/proc/self/status", encoding="ascii").read()',
    'effective = int(re.search(r"^CapEff:\\s+([0-9a-f]+)$", status, re.M).group(1), 16)',
    'no_new_privileges = re.search(r"^NoNewPrivs:\\s+1$", status, re.M) is not None',
    'seed = "/awf/seed/README.md"',
    'os.stat(seed)',
    'try:',
    '    fd = os.open(seed, os.O_WRONLY | os.O_APPEND)',
    'except OSError as error:',
    '    seed_read_only = error.errno == errno.EROFS',
    'else:',
    '    os.close(fd)',
    '    seed_read_only = False',
    'try:',
    '    socket.create_connection(("1.1.1.1", 443), timeout=2)',
    'except OSError:',
    '    no_network = True',
    'else:',
    '    no_network = False',
    '    raise SystemExit(1)',
    'try:',
    '    os.setuid(0)',
    'except PermissionError:',
    '    privilege_drop_denied = True',
    'else:',
    '    privilege_drop_denied = False',
    '    raise SystemExit(1)',
    'result = {',
    '    "uid": os.geteuid(), "gid": os.getegid(), "seedReadOnly": seed_read_only,',
    '    "noNetwork": no_network, "onlyLoopback": [n for _, n in socket.if_nameindex()] == ["lo"],',
    '    "privilegeDropDenied": privilege_drop_denied, "noNewPrivileges": no_new_privileges,',
    '    "emptyEffectiveCapabilities": effective == 0,',
    '    "processLimit": resource.getrlimit(resource.RLIMIT_NPROC)[0],',
    '    "fileSizeLimit": resource.getrlimit(resource.RLIMIT_FSIZE)[0],',
    '    "openFileLimit": resource.getrlimit(resource.RLIMIT_NOFILE)[0],',
    '}',
    'open("out", "w", encoding="utf8").write(json.dumps(result, separators=(",", ":")))',
  ].join('\n');
  const scriptResponse = await requestMcp(context.endpoint, context.gatewayKey, 3, 'tools/call', {
    name: 'enclave_run_script',
    arguments: { privateRepo: 'github/gh-aw-firewall', schema: context.scriptProbe.schema, script: context.python },
  });
  const scriptResult = parsePublicToolResult(scriptResponse, 3);
  if (scriptResult.status !== 'ok' || !isDeepStrictEqual(scriptResult.result, context.scriptProbe.expected)) {
    throw new Error('Live script enclave guest identity, filesystem, network, or resource assertion failed');
  }
  await waitForVmCleanup(15_000, context.primaryVmResidue);
}

async function runAgentScenario(context) {
  context.failureContext.stage = FAILURE_STAGES.AGENT;
  context.agentResultValue = 'AWF_ENCLAVE_LIVE_AGENT_RESULT';
  context.scopedGithubProbe = context.githubCapability ? buildScopedGithubGuestProbe() : undefined;
  const agentResponse = await requestMcp(context.endpoint, context.gatewayKey, 4, 'tools/call', {
    name: 'enclave_run_agent',
    arguments: {
      privateRepo: 'github/gh-aw-firewall',
      schema: context.scopedGithubProbe?.schema || { type: 'enum', values: [context.agentResultValue] },
      prompt: context.scopedGithubProbe?.prompt
        || `Return exactly the string ${JSON.stringify(context.agentResultValue)}. Do not inspect or quote repository files.`,
    },
  });
  const agentResult = parsePublicToolResult(agentResponse, 4);
  if (agentResult.status !== 'ok'
      || !isDeepStrictEqual(agentResult.result, context.scopedGithubProbe?.expected || context.agentResultValue)) {
    throw new Error('Live agent enclave did not return the bounded canonical result');
  }
  await waitForVmCleanup(15_000, context.primaryVmResidue);

  const agentProbe = buildAgentGuestProbe({ githubEnabled: !!context.githubCapability });
  const agentProbeResponse = await requestMcp(context.endpoint, context.gatewayKey, 5, 'tools/call', {
    name: 'enclave_run_agent',
    arguments: {
      privateRepo: 'github/gh-aw-firewall',
      schema: agentProbe.schema,
      prompt: agentProbe.prompt,
    },
  });
  assertExpectedToolResult(agentProbeResponse, 5, agentProbe.expected, 'agent identity and network');
  await waitForVmCleanup(15_000, context.primaryVmResidue);
}

async function runResourceLimitsScenario(context) {
  context.failureContext.stage = FAILURE_STAGES.RESOURCE_LIMITS;
  const agentEnospcProbe = buildAgentEnospcProbe();
  const agentEnospcResponse = await acceptanceCheck(context.failureContext, 'agent-enospc', 'request',
    () => requestMcp(context.endpoint, context.gatewayKey, 6, 'tools/call', {
      name: 'enclave_run_agent',
      arguments: {
        privateRepo: 'github/gh-aw-firewall',
        schema: agentEnospcProbe.schema,
        prompt: agentEnospcProbe.prompt,
      },
    }));
  await acceptanceCheck(context.failureContext, 'agent-enospc', 'result-validation',
    () => assertExpectedToolResult(agentEnospcResponse, 6, agentEnospcProbe.expected, 'agent aggregate ENOSPC'));
  await acceptanceCheck(context.failureContext, 'agent-enospc', 'cleanup',
    () => waitForVmCleanup(15_000, context.primaryVmResidue));

  const enospcExpected = { enospcObserved: true, probeFilesRemoved: true };
  const enospcResponse = await acceptanceCheck(context.failureContext, 'script-enospc', 'request',
    () => requestMcp(context.endpoint, context.gatewayKey, 7, 'tools/call', {
      name: 'enclave_run_script',
      arguments: {
        privateRepo: 'github/gh-aw-firewall',
        schema: buildConstantObjectSchema(enospcExpected),
        script: buildEnospcProbeScript(),
      },
    }));
  await acceptanceCheck(context.failureContext, 'script-enospc', 'result-validation',
    () => assertExpectedToolResult(enospcResponse, 7, enospcExpected, 'script aggregate ENOSPC'));
  await acceptanceCheck(context.failureContext, 'script-enospc', 'cleanup',
    () => waitForVmCleanup(15_000, context.primaryVmResidue));

  const oomExpected = { childKilledByOom: true, oomKillCounterIncreased: true };
  const oomResponse = await acceptanceCheck(context.failureContext, 'guest-oom', 'request',
    () => requestMcp(context.endpoint, context.gatewayKey, 8, 'tools/call', {
      name: 'enclave_run_script',
      arguments: {
        privateRepo: 'github/gh-aw-firewall',
        schema: buildConstantObjectSchema(oomExpected),
        script: buildOomProbeScript(),
      },
    }));
  await acceptanceCheck(context.failureContext, 'guest-oom', 'result-validation',
    () => assertExpectedToolResult(oomResponse, 8, oomExpected, 'guest OOM'));
  await acceptanceCheck(context.failureContext, 'guest-oom', 'cleanup',
    () => waitForVmCleanup(15_000, context.primaryVmResidue));
}

async function runFailureHandlingScenario(context) {
  context.failureContext.stage = FAILURE_STAGES.FAILURE_HANDLING;
  context.errorSchema = { type: 'const', value: true };
  const guestFailure = await acceptanceCheck(context.failureContext, 'guest-failure', 'request',
    () => requestMcp(context.endpoint, context.gatewayKey, 9, 'tools/call', {
      name: 'enclave_run_script',
      arguments: {
        privateRepo: 'github/gh-aw-firewall',
        schema: context.errorSchema,
        script: 'raise SystemExit(23)',
      },
    }));
  await acceptanceCheck(context.failureContext, 'guest-failure', 'result-validation',
    () => assertCanonicalToolError(guestFailure, 9));
  await acceptanceCheck(context.failureContext, 'guest-failure', 'cleanup',
    () => waitForVmCleanup(15_000, context.primaryVmResidue));

  context.journalRoot = HOST_EXECUTOR_DEFAULT_JOURNAL_DIRECTORY;
  const existingTimeoutResources = await acceptanceCheck(context.failureContext, 'guest-timeout', 'resource-baseline',
    () => new Set(resourceRecords(context.journalRoot).map(({ file }) => file)));
  const [timeout, timeoutActive] = await Promise.all([
    acceptanceCheck(context.failureContext, 'guest-timeout', 'request',
      () => requestMcp(context.endpoint, context.gatewayKey, 10, 'tools/call', {
        name: 'enclave_run_script',
        arguments: {
          privateRepo: 'github/gh-aw-firewall',
          schema: context.errorSchema,
          script: 'import time\nopen("/output/timeout-probe-started", "w").write("started")\ntime.sleep(150)',
        },
      })),
    (async () => {
      const active = await acceptanceCheck(context.failureContext, 'guest-timeout', 'resource-discovery',
        () => waitForInvocationRecord(context.journalRoot, existingTimeoutResources, context.awf.pid, 90_000));
      await acceptanceCheck(context.failureContext, 'guest-timeout', 'marker-wait',
        () => waitForPath(path.join(active.record.directory, 'output', 'timeout-probe-started'), 90_000));
      return active;
    })(),
  ]);
  await acceptanceCheck(context.failureContext, 'guest-timeout', 'result-validation',
    () => assertCanonicalToolError(timeout, 10));
  await acceptanceCheck(context.failureContext, 'guest-timeout', 'cleanup',
    () => waitForVmCleanup(15_000, context.primaryVmResidue));
  await acceptanceCheck(context.failureContext, 'guest-timeout', 'execution-validation',
    () => waitForInvocationOutcome(context.journalRoot, timeoutActive.record, 'timeout'));

  const existingCancellationResources = await acceptanceCheck(context.failureContext, 'guest-cancellation', 'resource-baseline',
    () => new Set(resourceRecords(context.journalRoot).map(({ file }) => file)));
  const cancellationMarker = [
    'import time',
    'open("/output/cancel-probe-started", "w", encoding="ascii").write("started")',
    'while True: time.sleep(1)',
  ].join('\n');
  const cancellationController = new AbortController();
  const cancellationRequest = acceptanceCheck(context.failureContext, 'guest-cancellation', 'request',
    () => requestMcp(context.endpoint, context.gatewayKey, 11, 'tools/call', {
      name: 'enclave_run_script',
      arguments: {
        privateRepo: 'github/gh-aw-firewall',
        schema: context.errorSchema,
        script: cancellationMarker,
      },
    }, cancellationController.signal));
  const [cancelled, cancellationActive] = await Promise.all([
    cancellationRequest,
    (async () => {
      const active = await acceptanceCheck(context.failureContext, 'guest-cancellation', 'resource-discovery',
        () => waitForInvocationRecord(context.journalRoot, existingCancellationResources, context.awf.pid, 90_000));
      await acceptanceCheck(context.failureContext, 'guest-cancellation', 'marker-wait',
        () => waitForPath(path.join(active.record.directory, 'output', 'cancel-probe-started'), 90_000));
      cancellationController.abort();
      return active;
    })(),
  ]);
  await acceptanceCheck(context.failureContext, 'guest-cancellation', 'disconnect-validation', () => {
    if (cancelled !== undefined) throw mcpFailure('disconnect-not-cancelled');
  });
  await acceptanceCheck(context.failureContext, 'guest-cancellation', 'cleanup',
    () => waitForVmCleanup(15_000, context.primaryVmResidue));
  await acceptanceCheck(context.failureContext, 'guest-cancellation', 'execution-validation',
    () => waitForInvocationOutcome(context.journalRoot, cancellationActive.record, 'cancelled'));
}

async function runStartupFaultsScenario(context) {
  context.failureContext.stage = FAILURE_STAGES.STARTUP_FAULTS;
  try {
    await require('../cloud-hypervisor-enclave-startup-faults').runStartupFaultProbes({
      directory: context.root,
      config: toAwfConfig(makeConfig(context.artifacts, context.workDir, context.workspace, context.handoff)).cloudHypervisor,
      environment: context.awfEnvironment,
      primaryVmResidue: context.primaryVmResidue,
    });
  } catch (error) {
    context.keepArtifacts = true;
    throw error;
  }
  await waitForVmCleanup(15_000, context.primaryVmResidue);
}

async function runCrashRecoveryScenario(context) {
  context.failureContext.stage = FAILURE_STAGES.CRASH_RECOVERY;
  const crashProbe = [
    'import time',
    'open("/output/crash-probe-started", "w", encoding="ascii").write("started")',
    'while True: time.sleep(1)',
  ].join('\n');
  const crashController = new AbortController();
  const interruptedWorkDir = context.workDir;
  await withCrashRecoveryCleanup(context.failureContext, async () => {
    const existingResources = await acceptanceCheck(context.failureContext, 'crash-recovery', 'resource-baseline',
      () => new Set(resourceRecords(context.journalRoot).map(({ file }) => file)));
    let crashResponse;
    await acceptanceCheck(context.failureContext, 'crash-recovery', 'request-start', () => {
      const crashRequest = requestMcp(context.endpoint, context.gatewayKey, 12, 'tools/call', {
        name: 'enclave_run_script',
        arguments: {
          privateRepo: 'github/gh-aw-firewall',
          schema: context.errorSchema,
          script: crashProbe,
        },
      }, crashController.signal);
      crashResponse = crashRequest.then(
        (response) => ({ response }),
        () => ({ disconnected: true }),
      );
    });
    const active = await acceptanceCheck(context.failureContext, 'crash-recovery', 'resource-discovery',
      () => waitForInvocationRecord(context.journalRoot, existingResources, context.awf.pid, 90_000));
    await acceptanceCheck(context.failureContext, 'crash-recovery', 'marker-wait',
      () => waitForPath(path.join(active.record.directory, 'output', 'crash-probe-started'), 90_000));
    const crashBaseline = await acceptanceCheck(context.failureContext, 'crash-recovery', 'resource-refresh',
      () => readCrashRecoveryBaseline(context.journalRoot, active, context.awf.pid));
    const vmmPid = await acceptanceCheck(context.failureContext, 'crash-recovery', 'vmm-discovery', () => {
      const apiSocket = path.join(crashBaseline.record.storage.directory, 'runs', 'vm', 'api.socket');
      const pid = findProcessForSocket(apiSocket);
      if (!pid) throw mcpFailure('vmm-not-found');
      return pid;
    });
    await acceptanceCheck(context.failureContext, 'crash-recovery', 'vmm-kill',
      () => process.kill(vmmPid, 'SIGKILL'));
    await acceptanceCheck(context.failureContext, 'crash-recovery', 'host-kill',
      () => killAwfForRecovery(context.awf));
    context.awf = undefined;
    const stdout = await acceptanceCheck(context.failureContext, 'crash-recovery', 'stdout-read',
      () => fs.readFileSync(context.awfOut, 'utf8'));
    const stderr = await acceptanceCheck(context.failureContext, 'crash-recovery', 'stderr-read',
      () => fs.readFileSync(context.awfErr, 'utf8'));
    const containerLogs = await acceptanceCheck(context.failureContext, 'crash-recovery', 'container-logs',
      () => context.captureLiveContainerLogs());
    context.preRestartLogContents = [stdout, stderr, ...containerLogs];
    await acceptanceCheck(context.failureContext, 'crash-recovery', 'compose-stop',
      () => context.stopComposeAfterCrash(interruptedWorkDir));
    await acceptanceCheck(context.failureContext, 'crash-recovery', 'recovery-config', () => {
      context.workDir = path.join(context.root, 'awf-work-recovery');
      context.awfConfigPath = path.join(context.root, 'awf-config-recovery.json');
      context.runDirectories.push(context.workDir);
      context.writeAwfConfig(context.workDir, context.awfConfigPath);
    });
    await acceptanceCheck(context.failureContext, 'crash-recovery', 'recovery-launch', () => {
      context.awf = context.launchAwf('recovery', 'combined');
    });
    await acceptanceCheck(context.failureContext, 'crash-recovery', 'broker-readiness',
      () => waitForBroker(context.awf, 'awf-enclave-mcp-server', Date.now() + 15 * 60_000, {
        stage: 'recovery', stderrFile: context.awfErr,
        startupErrorFile: path.join(context.workDir, 'proxy-logs', 'awf-startup-error.json'),
      }));
    await acceptanceCheck(context.failureContext, 'crash-recovery', 'gateway-readiness',
      () => waitForHostGatewayReadiness(context.awf, Date.now() + 150_000, {
        stage: 'recovery', stderrFile: context.awfErr,
        startupErrorFile: path.join(context.workDir, 'proxy-logs', 'awf-startup-error.json'),
      }));
    context.primaryVmResidue = await acceptanceCheck(context.failureContext, 'crash-recovery', 'primary-readiness',
      () => context.waitForPrimary(() => waitForPrimaryVmReadiness(context.awf, Date.now() + 5 * 60_000, {
        startupErrorFile: path.join(context.workDir, 'proxy-logs', 'awf-startup-error.json'),
      })));
    await acceptanceCheck(context.failureContext, 'crash-recovery', 'tools-list', async () => {
      const recoveryTools = await requestMcp(context.endpoint, context.gatewayKey, 13, 'tools/list', {});
      if (!Array.isArray(recoveryTools?.result?.tools)) {
        throw mcpFailure('recovery-tools-invalid', recoveryTools, 13);
      }
      return recoveryTools;
    });
    const recovered = await acceptanceCheck(context.failureContext, 'crash-recovery', 'resource-read',
      () => readRecoveredInvocation(context.journalRoot, active.file));
    await acceptanceCheck(context.failureContext, 'crash-recovery', 'recovery-validation',
      () => assertRecoveredInvocation(crashBaseline.record, recovered.after, recovered.records));
    await acceptanceCheck(context.failureContext, 'crash-recovery', 'interrupted-response', async () => {
      const result = await crashResponse;
      assertNoSuccessfulResult(result.response);
      return result;
    });
    await acceptanceCheck(context.failureContext, 'crash-recovery', 'cleanup',
      () => waitForVmCleanup(15_000, context.primaryVmResidue));
  }, [
    { phase: 'request-abort', action: () => crashController.abort() },
    { phase: 'host-cleanup', action: async () => {
      if (context.awf && context.awf.exitCode === null && context.awf.signalCode === null && !failedSpawns.has(context.awf)) {
        await stopAwf(context.awf);
      }
    } },
    { phase: 'compose-cleanup', action: () => context.stopComposeAfterCrash(interruptedWorkDir) },
  ], () => { context.keepArtifacts = true; });
}

async function runOutputRedactionScenario(context) {
  context.failureContext.stage = FAILURE_STAGES.OUTPUT_REDACTION;
  const logContents = [
    ...context.preRestartLogContents,
    fs.readFileSync(context.awfOut, 'utf8'),
    fs.readFileSync(context.awfErr, 'utf8'),
    ...context.captureLiveContainerLogs(),
  ];
  const privateRoots = context.runDirectories.map((directory) => path.join(
    '/var/tmp',
    `awf-enclave-private-0-${crypto.createHash('sha256')
      .update(path.resolve(directory), 'utf8').digest('hex').slice(0, 20)}`,
  ));
  const redactionDirectories = [
    ...context.runDirectories.flatMap((directory) => [
      path.join(directory, 'audit'),
      path.join(directory, 'proxy-logs'),
    ]),
    ...privateRoots.flatMap((directory) => [
      path.join(directory, 'audit'),
      path.join(directory, 'api-proxy-logs'),
    ]),
    context.journalRoot,
  ];
  for (const protectedValue of [context.sentinel, context.githubCapability?.bearer].filter(Boolean)) {
    assertNoSentinelLeak(redactionDirectories, logContents, protectedValue);
  }
}

async function runSingleExecutorProfilesScenario(context) {
  // Exercise each single-executor configuration through a fresh broker and real VM.
  // The combined run above retains the full failure/recovery coverage.
  for (const profile of ['script-only', 'agent-only']) {
    context.failureContext.stage = profile === 'script-only'
      ? FAILURE_STAGES.SCRIPT_ONLY : FAILURE_STAGES.AGENT_ONLY;
    await acceptanceCheck(context.failureContext, profile, 'stop-marker',
      () => fs.writeFileSync(path.join(context.workspace, '.awf-enclave-live-stop'), 'done\n', { mode: 0o644 }));
    await acceptanceCheck(context.failureContext, profile, 'host-stop', () => stopAwf(context.awf));
    await acceptanceCheck(context.failureContext, profile, 'host-stop-validation', () => {
      if (context.awf.exitCode !== 0 || context.awf.signalCode !== null) throw mcpFailure('profile-stop-invalid');
    });
    context.awf = undefined;
    await acceptanceCheck(context.failureContext, profile, 'stop-marker-remove',
      () => fs.rmSync(path.join(context.workspace, '.awf-enclave-live-stop')));
    await acceptanceCheck(context.failureContext, profile, 'profile-config', () => {
      context.workDir = path.join(context.root, `awf-work-${profile}`);
      context.awfConfigPath = path.join(context.root, `awf-config-${profile}.json`);
      context.runDirectories.push(context.workDir);
      context.writeAwfConfig(context.workDir, context.awfConfigPath, profile);
    });
    await acceptanceCheck(context.failureContext, profile, 'profile-launch', () => {
      context.awf = context.launchAwf(profile, profile);
    });
    const diagnostics = {
      stage: profile, stderrFile: context.awfErr,
      startupErrorFile: path.join(context.workDir, 'proxy-logs', 'awf-startup-error.json'),
    };
    await acceptanceCheck(context.failureContext, profile, 'broker-readiness',
      () => waitForBroker(context.awf, 'awf-enclave-mcp-server', Date.now() + 15 * 60_000, diagnostics));
    await acceptanceCheck(context.failureContext, profile, 'gateway-readiness',
      () => waitForHostGatewayReadiness(context.awf, Date.now() + 150_000, diagnostics));
    const profileStage = context.failureContext.stage;
    context.failureContext.stage = context.dockerPrimary ? FAILURE_STAGES.PRIMARY_DOCKER : FAILURE_STAGES.PRIMARY;
    context.primaryVmResidue = await acceptanceCheck(context.failureContext, profile, 'primary-readiness',
      () => context.waitForPrimary(() => waitForPrimaryVmReadiness(context.awf, Date.now() + 5 * 60_000, diagnostics)));
    context.failureContext.stage = profileStage;
    const requestId = profile === 'script-only' ? 14 : 17;
    const profileInit = await acceptanceCheck(context.failureContext, profile, 'initialize',
      () => requestMcp(context.endpoint, context.gatewayKey, requestId, 'initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'awf-live-enclave-conformance', version: '1.0.0' },
      }));
    await acceptanceCheck(context.failureContext, profile, 'initialize-validation',
      () => assertProfileInitialize(profileInit, requestId));
    const profileTools = await acceptanceCheck(context.failureContext, profile, 'tools-list',
      () => requestMcp(context.endpoint, context.gatewayKey, requestId + 1, 'tools/list', {}));
    await acceptanceCheck(context.failureContext, profile, 'tools-validation',
      () => assertProfileTools(profileTools, profile, requestId + 1));
    if (profile === 'script-only') {
      const response = await acceptanceCheck(context.failureContext, profile, 'request',
        () => requestMcp(context.endpoint, context.gatewayKey, requestId + 2, 'tools/call', {
          name: 'enclave_run_script',
          arguments: { privateRepo: 'github/gh-aw-firewall', schema: context.scriptProbe.schema, script: context.python },
        }));
      await acceptanceCheck(context.failureContext, profile, 'result-validation',
        () => assertExpectedToolResult(response, requestId + 2, context.scriptProbe.expected, 'script-only profile'));
    } else {
      const response = await acceptanceCheck(context.failureContext, profile, 'request',
        () => requestMcp(context.endpoint, context.gatewayKey, requestId + 2, 'tools/call', {
          name: 'enclave_run_agent',
          arguments: {
            privateRepo: 'github/gh-aw-firewall',
            schema: context.scopedGithubProbe?.schema || { type: 'enum', values: [context.agentResultValue] },
            prompt: context.scopedGithubProbe?.prompt
              || `Return exactly the string ${JSON.stringify(context.agentResultValue)}. Do not inspect or quote repository files.`,
          },
        }));
      await acceptanceCheck(context.failureContext, profile, 'result-validation',
        () => assertExpectedToolResult(response, requestId + 2,
          context.scopedGithubProbe?.expected || context.agentResultValue, 'agent-only profile'));
    }
    await acceptanceCheck(context.failureContext, profile, 'cleanup',
      () => waitForVmCleanup(15_000, context.primaryVmResidue));
    const profileStdout = await acceptanceCheck(context.failureContext, profile, 'stdout-read',
      () => fs.readFileSync(context.awfOut, 'utf8'));
    const profileStderr = await acceptanceCheck(context.failureContext, profile, 'stderr-read',
      () => fs.readFileSync(context.awfErr, 'utf8'));
    const profileContainerLogs = await acceptanceCheck(context.failureContext, profile, 'container-logs',
      () => context.captureLiveContainerLogs(profile));
    await acceptanceCheck(context.failureContext, profile, 'output-redaction', () => {
      const privateRoot = path.join(
        '/var/tmp',
        `awf-enclave-private-0-${crypto.createHash('sha256')
          .update(path.resolve(context.workDir), 'utf8').digest('hex').slice(0, 20)}`,
      );
      const directories = [
        path.join(context.workDir, 'audit'), path.join(context.workDir, 'proxy-logs'),
        path.join(privateRoot, 'audit'), path.join(privateRoot, 'api-proxy-logs'),
        context.journalRoot,
      ];
      for (const protectedValue of [context.sentinel, context.githubCapability?.bearer].filter(Boolean)) {
        assertNoSentinelLeak(directories, [profileStdout, profileStderr, ...profileContainerLogs], protectedValue);
      }
    });
  }
}

module.exports = {
  runMcpRouteScenario,
  runScriptScenario,
  runAgentScenario,
  runResourceLimitsScenario,
  runFailureHandlingScenario,
  runStartupFaultsScenario,
  runCrashRecoveryScenario,
  runOutputRedactionScenario,
  runSingleExecutorProfilesScenario,
};
