'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const conformanceDiagnostics = require('../cloud-hypervisor-enclave-diagnostics');
const CI_DIRECTORY = path.resolve(__dirname, '..');
const { FAILURE_STAGES, RELEASE_ASSETS, GATEWAY_CONTAINER } = require('./constants');
const { captureContainerLogs, run } = require('./commands');
const {
  waitForDockerPrimaryReadiness, waitForPrimaryVmReadiness, assertNoVmResidue,
} = require('./vm-readiness');
const {
  spawnAwf, makeGithubFixtureCapability, toAwfConfig, makeConfig, startGatewayFixture,
  stopAwf, removeGatewayFixture, removePrivateAwfLogs,
} = require('./fixtures');
const {
  startupSnapshot, failedSpawns, waitForBroker, waitForHostGatewayReadiness,
} = require('./startup-evidence');
const { prepareAcceptanceArtifacts, assertUnifiedProfiles } = require('./artifacts');
const {
  runMcpRouteScenario, runScriptScenario, runAgentScenario, runResourceLimitsScenario,
  runFailureHandlingScenario, runStartupFaultsScenario, runCrashRecoveryScenario,
  runOutputRedactionScenario, runSingleExecutorProfilesScenario,
} = require('./scenarios');

async function main(failureContext = { stage: FAILURE_STAGES.RUNNER }) {
  failureContext.stage = FAILURE_STAGES.RUNNER;
  if (process.getuid?.() !== 0 || process.env.GITHUB_ACTIONS !== 'true'
      || process.env.RUNNER_ENVIRONMENT !== 'github-hosted'
      || !/^ubuntu/.test(process.env.ImageOS || '')) {
    throw new Error('Live enclave acceptance requires an opted-in GitHub-hosted Ubuntu runner as root');
  }
  failureContext.stage = FAILURE_STAGES.CHECKOUT;
  const checkout = require('../cloud-hypervisor-enclave-candidate').verifyAcceptanceSource();
  failureContext.stage = FAILURE_STAGES.PUBLIC_SEED_TOKENS;
  if (!process.env.GH_TOKEN || !process.env.GITHUB_TOKEN) {
    throw new Error('Live enclave acceptance requires GH_TOKEN and GITHUB_TOKEN for public seed staging');
  }
  failureContext.stage = FAILURE_STAGES.COPILOT_TOKEN;
  if (!process.env.COPILOT_GITHUB_TOKEN) {
    throw new Error('Live agent-enclave acceptance requires the COPILOT_GITHUB_TOKEN repository secret');
  }
  failureContext.stage = FAILURE_STAGES.RELEASE;
  const environment = { ...process.env };
  const scopedGithubMode = environment.AWF_ENCLAVE_LIVE_SCOPED_GITHUB === '1';
  let dockerPrimary = scopedGithubMode;
  const runnerTemp = environment.RUNNER_TEMP || os.tmpdir();
  const root = fs.mkdtempSync(path.join(runnerTemp, 'awf-enclave-live-'));
  fs.chmodSync(root, 0o700);
  const artifactsDir = path.join(root, 'release-artifacts');
  let workDir = path.join(root, 'awf-work');
  const workspace = path.join(root, 'workspace');
  const gatewayEnv = path.join(root, 'gateway.env');
  const awfOut = path.join(root, 'awf.stdout.log');
  const awfErr = path.join(root, 'awf.stderr.log');
  const gatewayKey = crypto.randomBytes(36).toString('base64url');
  const capability = crypto.randomBytes(32).toString('hex');
  const gatewayIdentity = `gh-aw-${environment.GITHUB_RUN_ID}-${environment.GITHUB_RUN_ATTEMPT}-enclave-live`;
  let awf;
  let gatewayStarted = false;
  let keepArtifacts = false;
  let acceptancePassed = false;
  let preRestartLogContents;
  let awfConfigPath = path.join(root, 'awf-config.json');
  const runDirectories = [workDir];
  let awfEnvironment;
  let primaryVmResidue;
  let primaryReadyToken;
  const captureLiveContainerLogs = (profile) => captureContainerLogs(profile, dockerPrimary);
  const waitForPrimary = (vmReadiness) => dockerPrimary
    ? waitForDockerPrimaryReadiness(awf, Date.now() + 5 * 60_000, awfOut, primaryReadyToken)
    : vmReadiness();
  let diagnosticContext;
  const startupSnapshots = [];
  const launchAwf = (stage, profile = stage === 'initial' || stage === 'recovery' ? 'combined' : stage) => {
    dockerPrimary = scopedGithubMode && ['combined', 'agent-only'].includes(profile);
    primaryReadyToken = `AWF_DOCKER_PRIMARY_READY_${crypto.randomBytes(24).toString('hex')}`;
    const stopPath = dockerPrimary ? path.join(workspace, '.awf-enclave-live-stop')
      : '/workspace/.awf-enclave-live-stop';
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    const awfArguments = [
      path.resolve(CI_DIRECTORY, '../../dist/cli.js'),
      '--config', awfConfigPath,
      '--build-local',
      '--enable-api-proxy',
      '--max-num-tool-calls', '16',
      '--work-dir', workDir,
      '--log-level', 'error',
      '--agent-timeout', '45',
      '--',
      `${dockerPrimary ? `printf '%s\\n' ${quote(primaryReadyToken)}; ` : ''}`
        + `while [ ! -f ${quote(stopPath)} ]; do sleep 1; done`,
    ];
    const startupErrorFile = path.join(workDir, 'proxy-logs', 'awf-startup-error.json');
    let child;
    try {
      child = spawnAwf(awfArguments, awfEnvironment, awfOut, awfErr, stage);
    } catch {
      startupSnapshots.push(startupSnapshot(undefined, 'spawn-failure', stage, profile, awfErr, startupErrorFile));
      throw new Error('Could not launch AWF before public enclave broker readiness');
    }
    const snapshot = { stage, profile, child, stderrFile: awfErr, startupErrorFile };
    startupSnapshots.push(snapshot);
    const capture = (reason) => {
      if (snapshot.diagnostic) return;
      Object.assign(snapshot, startupSnapshot(child, reason, stage, profile, awfErr, startupErrorFile));
      delete snapshot.child;
      delete snapshot.stderrFile;
      delete snapshot.startupErrorFile;
    };
    child.once('exit', () => capture(failedSpawns.has(child) ? 'spawn-failure'
      : child.signalCode ? 'signal' : 'exit'));
    child.once('error', () => {
      if (failedSpawns.has(child)) capture('spawn-failure');
    });
    return child;
  };
  const stopComposeAfterCrash = (composeWorkDir = workDir) => run('docker', [
    'compose',
    '--project-directory', composeWorkDir,
    '--file', path.join(composeWorkDir, 'docker-compose.yml'),
    'down', '--volumes', '--remove-orphans', '--timeout', '5',
  ]);
  try {
    failureContext.stage = FAILURE_STAGES.RELEASE;
    const artifacts = prepareAcceptanceArtifacts(checkout, artifactsDir, environment);
    const { assertManifestSource } = require('../cloud-hypervisor-enclave-release-gate');
    for (const manifestPath of [
      path.join(artifacts.directory, RELEASE_ASSETS[1]),
      artifacts.enclaveArtifactEnvironment.AWF_CLOUD_HYPERVISOR_ENCLAVE_MANIFEST,
    ]) {
      assertManifestSource(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), checkout.tag, checkout.commit);
    }
    assertUnifiedProfiles(
      artifacts,
      JSON.parse(fs.readFileSync(path.join(artifacts.directory, RELEASE_ASSETS[1]), 'utf8')),
      JSON.parse(fs.readFileSync(artifacts.enclaveArtifactEnvironment.AWF_CLOUD_HYPERVISOR_ENCLAVE_MANIFEST, 'utf8')),
      JSON.parse(fs.readFileSync(path.join(artifacts.enclaveDirectory, 'enclave-rootfs.sbom.spdx.json'), 'utf8')),
    );
    const githubCapability = scopedGithubMode
      ? makeGithubFixtureCapability(gatewayIdentity, gatewayKey) : undefined;
    fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(workspace, { recursive: true, mode: 0o755 });
    fs.chmodSync(workspace, 0o755);
    fs.mkdirSync(path.join(workDir, 'audit'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(workDir, 'proxy-logs'), { recursive: true, mode: 0o700 });
    diagnosticContext = conformanceDiagnostics.prepareForJob(
      toAwfConfig(makeConfig(artifacts, workDir, workspace, { githubCapability })), 'live',
    );
    if (diagnosticContext) {
      failureContext.observeAdmission = () => conformanceDiagnostics.captureAdmissionEvidence(
        diagnosticContext, require('../../../dist/enclave/paths').resolveEnclavePaths(workDir).auditDir,
      );
    }
    failureContext.stage = FAILURE_STAGES.GATEWAY;
    const handoff = startGatewayFixture({
      gatewayEnv, gatewayKey, capability, identity: gatewayIdentity,
      githubCapability,
      onStarted: () => { gatewayStarted = true; },
    });
    const { endpoint } = handoff;
    const writeAwfConfig = (targetWorkDir, targetConfigPath, profile = 'combined') => {
      fs.mkdirSync(targetWorkDir, { recursive: true, mode: 0o700 });
      fs.mkdirSync(path.join(targetWorkDir, 'audit'), { recursive: true, mode: 0o700 });
      fs.mkdirSync(path.join(targetWorkDir, 'proxy-logs'), { recursive: true, mode: 0o700 });
      const config = toAwfConfig(makeConfig(artifacts, targetWorkDir, workspace, handoff, profile));
      fs.writeFileSync(targetConfigPath, `${JSON.stringify(config, null, 2)}\n`, {
        mode: 0o600,
        flag: 'wx',
      });
    };
    writeAwfConfig(workDir, awfConfigPath);
    awfEnvironment = {
      ...environment,
      ...artifacts.enclaveArtifactEnvironment,
      AWF_ENCLAVE_MCP_CAPABILITY: capability,
      AWF_ENCLAVE_MCP_GATEWAY_CONTAINER: GATEWAY_CONTAINER,
      AWF_ENCLAVE_MCP_GATEWAY_ENDPOINT: endpoint,
      AWF_ENCLAVE_MCP_GATEWAY_IDENTITY: gatewayIdentity,
      AWF_ENCLAVE_MCP_READINESS_TIMEOUT_MS: '120000',
      MCP_GATEWAY_API_KEY: gatewayKey,
      GITHUB_WORKSPACE: workspace,
      GH_TOKEN: environment.GH_TOKEN,
      GITHUB_TOKEN: environment.GITHUB_TOKEN,
      ...(githubCapability ? {
        AWF_ENCLAVE_GITHUB_MCP_AGENT_ID: githubCapability.agentId,
        AWF_ENCLAVE_GITHUB_EXECUTOR_CAPABILITY: JSON.stringify(githubCapability),
      } : {}),
    };
    failureContext.stage = FAILURE_STAGES.BROKER;
    awf = launchAwf('initial', 'combined');
    await waitForBroker(awf, 'awf-enclave-mcp-server', Date.now() + 15 * 60_000, {
      stage: 'initial', stderrFile: awfErr,
      startupErrorFile: path.join(workDir, 'proxy-logs', 'awf-startup-error.json'),
    });
    await waitForHostGatewayReadiness(awf, Date.now() + 150_000, {
      stage: 'initial', stderrFile: awfErr,
      startupErrorFile: path.join(workDir, 'proxy-logs', 'awf-startup-error.json'),
    });
    failureContext.stage = dockerPrimary ? FAILURE_STAGES.PRIMARY_DOCKER : FAILURE_STAGES.PRIMARY;
    primaryVmResidue = await waitForPrimary(() => waitForPrimaryVmReadiness(awf, Date.now() + 5 * 60_000, {
      startupErrorFile: path.join(workDir, 'proxy-logs', 'awf-startup-error.json'),
    }));

    // Keep scenario mutations visible to launch callbacks and failure cleanup.
    const context = {
      failureContext,
      endpoint,
      gatewayKey,
      githubCapability,
      root,
      artifacts,
      workspace,
      handoff,
      awfEnvironment,
      awfOut,
      awfErr,
      runDirectories,
      captureLiveContainerLogs,
      waitForPrimary,
      launchAwf,
      stopComposeAfterCrash,
      writeAwfConfig,
      get awf() { return awf; },
      set awf(value) { awf = value; },
      get workDir() { return workDir; },
      set workDir(value) { workDir = value; },
      get awfConfigPath() { return awfConfigPath; },
      set awfConfigPath(value) { awfConfigPath = value; },
      get primaryVmResidue() { return primaryVmResidue; },
      set primaryVmResidue(value) { primaryVmResidue = value; },
      get preRestartLogContents() { return preRestartLogContents; },
      set preRestartLogContents(value) { preRestartLogContents = value; },
      get keepArtifacts() { return keepArtifacts; },
      set keepArtifacts(value) { keepArtifacts = value; },
      get dockerPrimary() { return dockerPrimary; },
      set dockerPrimary(value) { dockerPrimary = value; },
    };
    await runMcpRouteScenario(context);
    await runScriptScenario(context);
    await runAgentScenario(context);
    await runResourceLimitsScenario(context);
    await runFailureHandlingScenario(context);
    await runStartupFaultsScenario(context);
    await runCrashRecoveryScenario(context);
    await runOutputRedactionScenario(context);
    await runSingleExecutorProfilesScenario(context);
    acceptancePassed = true;
    console.log('Live combined, script-only, and agent-only profile invocations, guest identity/network, resource limits, failure/timeout/cancellation, VMM crash recovery, cleanup, and output redaction checks passed.');
  } finally {
    if (acceptancePassed) failureContext.stage = FAILURE_STAGES.CLEANUP;
    try {
      if (awf && awf.exitCode === null && awf.signalCode === null && !failedSpawns.has(awf)) {
        try {
          fs.writeFileSync(path.join(workspace, '.awf-enclave-live-stop'), 'done\n', { mode: 0o644 });
          await stopAwf(awf);
        } catch {
          console.error('Could not stop AWF within live fixture cleanup');
          keepArtifacts = true;
          process.exitCode = 1;
        }
      }
      if (gatewayStarted && !removeGatewayFixture(gatewayIdentity)) {
        keepArtifacts = true;
        process.exitCode = 1;
      }
      try {
        assertNoVmResidue();
      } catch (error) {
        console.error(error.message);
        keepArtifacts = true;
        process.exitCode = 1;
      }
    } catch {
      console.error('Live enclave fixture cleanup failed; private recovery state was preserved');
      keepArtifacts = true;
      process.exitCode = 1;
    } finally {
      try {
        for (const snapshot of startupSnapshots) {
          if (snapshot.diagnostic) continue;
          const child = snapshot.child;
          const reason = child && failedSpawns.has(child) ? 'spawn-failure'
            : child?.signalCode ? 'signal' : child?.exitCode !== null && child?.exitCode !== undefined
              ? 'exit' : 'unknown';
          Object.assign(snapshot, startupSnapshot(
            child, reason, snapshot.stage, snapshot.profile, snapshot.stderrFile, snapshot.startupErrorFile,
          ));
          delete snapshot.child;
          delete snapshot.stderrFile;
          delete snapshot.startupErrorFile;
        }
        conformanceDiagnostics.collect(diagnosticContext, {
          status: acceptancePassed && !process.exitCode ? 'passed' : 'failed',
          stage: Object.values(FAILURE_STAGES).includes(failureContext.stage) ? failureContext.stage : 'unknown stage',
          check: failureContext.check,
          checks: failureContext.checks,
          admissionEvidence: failureContext.admissionEvidence,
          startup: startupSnapshots.map(({ stage, profile, diagnostic, evidence }) =>
            ({ stage, profile, diagnostic, evidence })),
        });
      } catch {
        console.error('Could not retain public enclave conformance diagnostics; raw files will not be uploaded.');
        process.exitCode = 1;
      }
      try {
        removePrivateAwfLogs(awfOut, awfErr, runDirectories.map(
          (directory) => path.join(directory, 'proxy-logs', 'awf-startup-error.json'),
        ));
        if (keepArtifacts) {
          console.error('Live enclave private recovery state was retained on the ephemeral runner; AWF stdout/stderr and startup error records were removed.');
        } else {
          fs.rmSync(root, { recursive: true, force: true });
        }
      } catch {
        console.error('Could not remove live enclave private diagnostic files');
        process.exitCode = 1;
      }
    }
  }
}

function reportFailure(_error, stage) {
  const safeStage = Object.values(FAILURE_STAGES).includes(stage) ? stage : 'unknown stage';
  console.error(
    `Live enclave acceptance failed during ${safeStage}; raw error details were suppressed. `
    + 'Review AWF_ENCLAVE_ACCEPTANCE_CHECK, AWF_HOST_STARTUP_DIAGNOSTIC and AWF_PRIMARY_VM_READINESS records above.',
  );
  process.exitCode = 1;
}

module.exports = {
  main,
  reportFailure,
};
