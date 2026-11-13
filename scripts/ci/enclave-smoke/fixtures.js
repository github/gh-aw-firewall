'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { GATEWAY_CONTAINER, RELEASE_ASSETS, GATEWAY_IMAGE } = require('./constants');
const { trackAwfChild, emitStartupDiagnostic } = require('./startup-evidence');
const { run } = require('./commands');
const { mcpFailure, mcpFailures } = require('./mcp-client');

function makeGithubFixtureCapability(identity, gatewayKey, now = Date.now()) {
  const agentId = crypto.randomBytes(32).toString('hex');
  let bearer;
  do { bearer = crypto.randomBytes(36).toString('base64url'); } while (bearer === gatewayKey || bearer === agentId);
  return {
    version: 1, gatewayIdentity: identity, executor: 'agent', agentId, bearer,
    issuedAt: now, expiresAt: now + 3600_000,
    allowedTools: ['issue_read', 'list_issues'],
    allowedRepos: ['github/gh-aw-firewall'], minIntegrity: null,
  };
}

function makeConfig(artifacts, workDir, workspace, handoff, profile = 'combined') {
  const enclaveRepository = { repo: 'github/gh-aw-firewall', sensitivity: 'public' };
  const main = artifacts.directory;
  return {
    network: {
      isolation: true,
      allowDomains: ['github.com', 'api.github.com', 'api.githubcopilot.com'],
      topologyAttach: [GATEWAY_CONTAINER],
    },
    cloudHypervisor: {
      previewEnabled: true,
      mountPolicy: 'workspace-only',
      artifactReleaseTag: artifacts.tag,
      cloudHypervisorBinary: path.join(main, 'cloud-hypervisor'),
      kernelPath: path.join(main, 'vmlinux.bin'),
      rootfsPath: path.join(main, 'rootfs.ext4'),
      supervisorPath: path.join(main, 'awf-supervisor'),
      artifactManifestPath: path.join(main, RELEASE_ASSETS[1]),
      artifactManifestBundlePath: path.join(main, RELEASE_ASSETS[2]),
      vcpuCount: 1,
      memoryMib: 768,
      apiTimeoutMs: require('../../../dist/types/runtime-options').CLOUD_HYPERVISOR_DEFAULT_API_TIMEOUT_MS,
    },
    enclaves: [
      {
        script: { maxScriptBytes: 16_384 },
        runtime: 'cloud-hypervisor',
        timeout: 120,
        maxInvocations: 8,
        repos: [enclaveRepository],
      },
      {
        agent: {
          model: 'gpt-4.1',
          engine: 'copilot',
          profile: 'openai',
          maxTaskBytes: 4096,
          ...(handoff.githubCapability ? { tools: { github: {
            allowed: handoff.githubCapability.allowedTools,
            allowedRepos: handoff.githubCapability.allowedRepos,
          } } } : {}),
        },
        runtime: 'cloud-hypervisor',
        timeout: 360,
        maxInvocations: 3,
        repos: [enclaveRepository],
      },
    ].filter((entry) => profile === 'combined'
      || (profile === 'script-only' && entry.script)
      || (profile === 'agent-only' && entry.agent)),
    container: {
      containerRuntime: handoff.githubCapability && ['combined', 'agent-only'].includes(profile)
        ? 'docker' : 'cloud-hypervisor',
      imageTag: artifacts.tag,
    },
    apiProxy: { enabled: true },
    logging: {
      auditDir: path.join(workDir, 'audit'),
      proxyLogsDir: path.join(workDir, 'proxy-logs'),
    },
    testWorkspace: workspace,
    testGateway: handoff,
  };
}

function toAwfConfig(config) {
  const { testWorkspace, testGateway, enclaves, ...awfConfig } = config;
  void testWorkspace;
  void testGateway;
  return enclaves.length ? { ...awfConfig, enclaves } : awfConfig;
}

function spawnAwf(awfArguments, environment, stdoutFile, stderrFile, stage) {
  let stdout;
  let stderr;
  try {
    stdout = fs.openSync(stdoutFile, 'w', 0o600);
    stderr = fs.openSync(stderrFile, 'w', 0o600);
    const child = spawn(process.execPath, awfArguments, {
      env: { ...environment, NO_COLOR: '1', FORCE_COLOR: '0' },
      stdio: ['ignore', stdout, stderr],
    });
    return trackAwfChild(child);
  } catch {
    emitStartupDiagnostic(undefined, 'spawn-failure', stage, stderrFile);
    throw new Error('Could not launch AWF before public enclave broker readiness');
  } finally {
    if (stdout !== undefined) fs.closeSync(stdout);
    if (stderr !== undefined) fs.closeSync(stderr);
  }
}

// The key reaches the fixture only through a private env file, never argv or logs.
function startGatewayFixture({ gatewayEnv, gatewayKey, capability, identity, githubCapability, onStarted }) {
  fs.writeFileSync(gatewayEnv, [
    'MCP_GATEWAY_PORT=8080',
    `MCP_GATEWAY_API_KEY=${gatewayKey}`,
    `AWF_ENCLAVE_MCP_CAPABILITY=${capability}`,
    ...(githubCapability ? [
      `AWF_ENCLAVE_MCP_GATEWAY_IDENTITY=${identity}`,
      `AWF_ENCLAVE_GITHUB_MCP_AGENT_ID=${githubCapability.agentId}`,
      `AWF_ENCLAVE_GITHUB_EXECUTOR_CAPABILITY=${JSON.stringify(githubCapability)}`,
    ] : []),
    '',
  ].join('\n'), { mode: 0o600, flag: 'wx' });

  run('docker', [
    'run', '--detach', '--name', GATEWAY_CONTAINER,
    '--label', `com.github.gh-aw.mcpg.run=${identity}`,
    '--publish', '127.0.0.1::8080',
    '--env-file', gatewayEnv,
    GATEWAY_IMAGE,
  ]);
  onStarted?.();
  const gatewayInspect = JSON.parse(run('docker', [
    'inspect', '--format', '{{json .NetworkSettings.Ports}}', GATEWAY_CONTAINER,
  ]));
  const mapping = gatewayInspect['8080/tcp']?.[0];
  if (!mapping?.HostPort) throw new Error('Live enclave gateway did not bind its loopback route');
  return {
    capability,
    gatewayKey,
    endpoint: `http://127.0.0.1:${mapping.HostPort}/mcp/awf-enclave`,
    identity,
    ...(githubCapability ? { githubCapability } : {}),
  };
}

function removeGatewayFixture(identity) {
  const gateway = spawnSync('docker', [
    'inspect', '--format', '{{ index .Config.Labels "com.github.gh-aw.mcpg.run" }}',
    GATEWAY_CONTAINER,
  ], { encoding: 'utf8' });
  if (gateway.status === 0 && gateway.stdout.trim() === identity) {
    const removed = spawnSync('docker', ['rm', '--force', GATEWAY_CONTAINER], { encoding: 'utf8' });
    if (removed.error || removed.status !== 0) {
      console.error('Could not remove the identity-checked live gateway fixture');
      return false;
    }
    return true;
  }
  console.error('Could not verify the live gateway fixture identity; it was not removed');
  return false;
}

function removePrivateAwfLogs(stdoutFile, stderrFile, startupErrorFiles = []) {
  let failed = false;
  for (const file of [stdoutFile, stderrFile, ...startupErrorFiles,
    ...startupErrorFiles.map((startupFile) =>
      path.join(path.dirname(startupFile), 'cloud-hypervisor', 'awf-primary-vm-readiness.json')),
  ]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      failed = true;
    }
  }
  if (failed) throw new Error('Could not remove live enclave private diagnostic files');
}

function stopAwf(child, graceMs = 60_000, terminateMs = 5000) {
  return new Promise((resolve, reject) => {
    if (typeof child.exitCode === 'number' || child.signalCode) {
      resolve();
      return;
    }
    const sendSignal = (signal) => {
      try {
        child.kill(signal);
        return true;
      } catch (cause) {
        onError(cause);
        return false;
      }
    };
    const terminate = setTimeout(() => sendSignal('SIGTERM'), graceMs);
    const kill = setTimeout(() => {
      if (sendSignal('SIGKILL')) {
        finish(new Error('AWF did not exit within the live fixture cleanup deadline'));
      }
    }, graceMs + terminateMs);
    const finish = (error) => {
      clearTimeout(terminate);
      clearTimeout(kill);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      if (error) reject(error);
      else resolve();
    };
    const onExit = () => finish();
    const onError = (cause) => {
      const error = mcpFailure('host-kill-failed');
      mcpFailures.get(error).code = cause?.code;
      finish(error);
    };
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

module.exports = {
  makeGithubFixtureCapability,
  makeConfig,
  toAwfConfig,
  spawnAwf,
  startGatewayFixture,
  removeGatewayFixture,
  removePrivateAwfLogs,
  stopAwf,
};
