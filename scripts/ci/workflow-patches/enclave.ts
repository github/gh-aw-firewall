import type { PatchContext, TransformResult } from './types';
import { installStepRegexGlobal } from './network-and-install-patterns';
import { buildBranchEnclaveInstallSteps } from '../workflow-step-builders';

function enclaveSmokeKinds(workflowPath: string) {
  const isCloudHypervisorEnclaveSmoke =
    workflowPath.endsWith('smoke-enclave-cloud-hypervisor.lock.yml');
  const isCloudHypervisorAgentEnclaveSmoke =
    workflowPath.endsWith('smoke-enclave-cloud-hypervisor-copilot.lock.yml');
  const isEnclaveSmoke =
    isCloudHypervisorEnclaveSmoke ||
    isCloudHypervisorAgentEnclaveSmoke ||
    workflowPath.endsWith('smoke-enclave-build-test.lock.yml') ||
    workflowPath.endsWith('smoke-enclave-issues-read.lock.yml') ||
    workflowPath.endsWith('smoke-enclave-dynamic-issues-read.lock.yml');
  return { isCloudHypervisorEnclaveSmoke, isCloudHypervisorAgentEnclaveSmoke, isEnclaveSmoke };
}

export function normalizeEnclaveGatewayPolicy(content: string, { workflowPath }: PatchContext): TransformResult {
  const messages: string[] = [];
  if (workflowPath.endsWith('smoke-enclave-issues-read.lock.yml')) {
    const original = content;
    const gatewayImage = 'ghcr.io/github/gh-aw-mcpg:v0.4.36';
    const gatewayDigest = 'sha256:b4d2856018959c798b3e3f81ae4ab5b275e06354e123e1f7971de931f2f450f2';
    const pinnedGatewayImage = `${gatewayImage}@${gatewayDigest}`;
    content = content.replace(
      /ghcr\.io\/github\/gh-aw-mcpg:[\w.-]+(?:@sha256:[a-f0-9]{64})?/g,
      pinnedGatewayImage
    );
    content = content.replace(/(GH_AW_INFO_AWMG_VERSION: ")[^"]*(")/g, '$1v0.4.36$2');
    // Preserve the last-green flat-response server and approved integrity guard.
    const githubImage = 'ghcr.io/github/github-mcp-server:v1.12.2';
    const githubDigest = 'sha256:508a0857ec762b1ab1cece29193345b501fab1dd9d1228a7b617062954cecac6';
    const pinnedGithubImage = `${githubImage}@${githubDigest}`;
    content = content.replace(
      /ghcr\.io\/github\/github-mcp-server:[\w.-]+(?:@sha256:[a-f0-9]{64})?/g,
      pinnedGithubImage
    );
    content = content.replace(
      /^(# gh-aw-manifest: )(.+)$/m,
      (_match, prefix: string, json: string) => {
        const manifest = JSON.parse(json) as {
          containers?: Array<{ image: string; digest: string; pinned_image: string }>;
        };
        for (const container of manifest.containers ?? []) {
          if (container.image === pinnedGatewayImage) {
            container.image = gatewayImage;
            container.digest = gatewayDigest;
            container.pinned_image = pinnedGatewayImage;
          }
          if (container.image === pinnedGithubImage) {
            container.image = githubImage;
            container.digest = githubDigest;
            container.pinned_image = pinnedGithubImage;
          }
        }
        return prefix + JSON.stringify(manifest);
      }
    );
    content = content
      .split('\n')
      .map(line =>
        line.includes('"agentPolicies":')
          ? line.replace(/"safe-outputs"/g, '"safeoutputs"')
          : line
      )
      .join('\n');
    content = content.replace(
      '"GITHUB_TOOLSETS": "context"',
      '"GITHUB_TOOLSETS": "context,issues"'
    );
    content = content.replace(
      /"github": \{\n(\s*)"type": "stdio"/,
      '"github": {\n$1"required": false,\n$1"type": "stdio"'
    );
    content = content.replace(
      'export GH_AW_MCP_DEFERRED_SERVERS="awf-enclave,github"',
      'export GH_AW_MCP_DEFERRED_SERVERS="awf-enclave"'
    );
    content = content.replace(
      /"min-integrity": "\$GITHUB_MCP_GUARD_MIN_INTEGRITY",\n(\s*)"repos": "\$GITHUB_MCP_GUARD_REPOS"/,
      '"min-integrity": "approved",\n$1"repos": ["github/gh-aw"]'
    );
    if (content !== original) {
      messages.push('  Normalized shared-gateway policy, server IDs, and toolsets');
    }
  }
  return { content, messages };
}

export function configureEnclaveReadiness(content: string, { workflowPath }: PatchContext): TransformResult {
  const messages: string[] = [];
  const { isCloudHypervisorEnclaveSmoke, isCloudHypervisorAgentEnclaveSmoke, isEnclaveSmoke } =
    enclaveSmokeKinds(workflowPath);
  if (isEnclaveSmoke) {
    const optionalEnclaveServer = '"awf-enclave": {\n                "required": false,';
    if (content.includes(optionalEnclaveServer)) {
      messages.push(`  Enclave MCP backend already marked optional during gateway startup`);
    } else {
      const enclaveServerAnchor = '"awf-enclave": {\n                "type": "http",';
      if (!content.includes(enclaveServerAnchor)) {
        throw new Error('Could not find the enclave MCP backend in the compiled smoke workflow');
      }
      content = content.replace(
        enclaveServerAnchor,
        '"awf-enclave": {\n                "required": false,\n                "type": "http",'
      );
      messages.push(`  Marked enclave MCP backend optional during gateway startup`);
    }
  }
  if (isEnclaveSmoke) {
    const gatewayKeyEnv =
      '          MCP_GATEWAY_API_KEY: ${{ steps.start-mcp-gateway.outputs.gateway-api-key }}';
    const agentStepStart = content.indexOf('      - name: Execute GitHub Copilot CLI');
    const agentEnvHeader = '        env:\n';
    const agentEnvStart =
      agentStepStart === -1 ? -1 : content.indexOf(agentEnvHeader, agentStepStart);
    if (agentEnvStart === -1) {
      throw new Error('Could not find the enclave smoke agent environment');
    }
    const nextStepStart = content.indexOf('\n      - name:', agentEnvStart + agentEnvHeader.length);
    const agentEnvEnd = nextStepStart === -1 ? content.length : nextStepStart;
    const agentEnvBlock = content.slice(agentEnvStart, agentEnvEnd);
    const gatewayKeyCount = agentEnvBlock.split(gatewayKeyEnv).length - 1;
    if (gatewayKeyCount === 1) {
      messages.push(`  Gateway API key already available to AWF readiness checks`);
    } else {
      let normalizedAgentEnv = agentEnvBlock
        .split('\n')
        .filter(line => line !== gatewayKeyEnv)
        .join('\n');
      normalizedAgentEnv = normalizedAgentEnv.replace(
        agentEnvHeader,
        `${agentEnvHeader}${gatewayKeyEnv}\n`
      );
      content =
        content.slice(0, agentEnvStart) +
        normalizedAgentEnv +
        content.slice(agentEnvEnd);
      if (gatewayKeyCount > 1) {
        messages.push(`  Removed duplicate gateway API key entries from enclave smoke agent environment`);
      } else {
        messages.push(`  Exposed gateway API key to AWF readiness checks`);
      }
    }
    const gatewayKeyExclusion = '--exclude-env MCP_GATEWAY_API_KEY';
    if (content.includes(gatewayKeyExclusion)) {
      messages.push(`  Gateway API key already excluded from the primary agent`);
    } else {
      const gatewayAgentIdExclusion = '--exclude-env MCP_GATEWAY_AGENT_ID';
      if (content.includes(gatewayAgentIdExclusion)) {
        content = content.replace(
          gatewayAgentIdExclusion,
          `${gatewayKeyExclusion} ${gatewayAgentIdExclusion}`
        );
        messages.push(`  Excluded gateway API key from the primary agent`);
      }
    }
    if (workflowPath.endsWith('smoke-enclave-issues-read.lock.yml')) {
      const stagingTokenEnv =
        '          GH_TOKEN: ${{ secrets.GH_AW_GITHUB_MCP_SERVER_TOKEN || secrets.GH_AW_GITHUB_TOKEN || secrets.GITHUB_TOKEN }}';
      if (!content.slice(agentEnvStart, agentEnvEnd).includes(stagingTokenEnv)) {
        content = content.replace(gatewayKeyEnv, `${gatewayKeyEnv}\n${stagingTokenEnv}`);
        messages.push(`  Added host-only enclave repository staging credential`);
      }
      const stagingTokenExclusion = '--exclude-env GH_TOKEN';
      if (!content.includes(stagingTokenExclusion)) {
        content = content.replace(
          gatewayKeyExclusion,
          `${stagingTokenExclusion} ${gatewayKeyExclusion}`
        );
        messages.push(`  Excluded enclave staging credential from the primary agent`);
      }
    }
    if (isCloudHypervisorAgentEnclaveSmoke && !content.includes('--exclude-env GH_TOKEN')) {
      content = content.replace(
        gatewayKeyExclusion,
        `--exclude-env GH_TOKEN ${gatewayKeyExclusion}`
      );
      messages.push(`  Excluded agent enclave staging credential from the primary agent`);
    }
    if (isCloudHypervisorEnclaveSmoke) {
      const rootfsExclusion = '--exclude-env AWF_CLOUD_HYPERVISOR_ENCLAVE_ROOTFS';
      if (!content.includes(rootfsExclusion)) {
        if (!content.includes(gatewayKeyExclusion)) {
          throw new Error('Could not find the primary-agent environment exclusion anchor');
        }
        content = content.replace(
          gatewayKeyExclusion,
          `${rootfsExclusion} ${gatewayKeyExclusion}`
        );
        messages.push(`  Excluded host-only enclave rootfs from the primary agent`);
      }
      const stagingTokenExclusion = '--exclude-env GH_TOKEN';
      if (!content.includes(stagingTokenExclusion)) {
        if (!content.includes(gatewayKeyExclusion)) {
          throw new Error('Could not find the primary-agent environment exclusion anchor');
        }
        content = content.replace(
          gatewayKeyExclusion,
          `${stagingTokenExclusion} ${gatewayKeyExclusion}`
        );
        messages.push(`  Excluded enclave staging credential from the primary agent`);
      }
    }
  }
  return { content, messages };
}

export function preserveWritableMetadata(content: string): TransformResult {
  // The downloaded metadata file is not a directory, unlike other allow-write entries.
  content = content.replace(
    /^([ \t]*mkdir -p "\$\{GITHUB_WORKSPACE\}\/\.awf-home"[^\n]*) "\/tmp\/gh-aw\/aw_info\.json"([^\n]*)$/gm,
    '$1$2',
  );
  return { content, messages: [] };
}

export function configureEnclaveDiagnostics(content: string, { workflowPath }: PatchContext): TransformResult {
  const messages: string[] = [];
  const { isCloudHypervisorEnclaveSmoke, isCloudHypervisorAgentEnclaveSmoke } =
    enclaveSmokeKinds(workflowPath);
  if (isCloudHypervisorEnclaveSmoke || isCloudHypervisorAgentEnclaveSmoke) {
    const enclaveRelease = isCloudHypervisorAgentEnclaveSmoke
      ? {
          version: 'v0.28.66',
          checksum: 'f184f3993a1f0c3168d0dd96b01752670a5061c9c9bc1a37e3653fc6b54fba29',
        }
      : {
          version: 'v0.28.66',
          checksum: 'f184f3993a1f0c3168d0dd96b01752670a5061c9c9bc1a37e3653fc6b54fba29',
        };
    const unpinnedEnclaveInstall = new RegExp(
      `(^[ \\t]*run: bash "\\$\\{RUNNER_TEMP\\}/gh-aw/actions/install_awf_binary\\.sh" ${enclaveRelease.version.replace(/\./g, '\\.')})(?=\\r?$)`,
      'gm',
    );
    content = content.replace(
      unpinnedEnclaveInstall,
      `$1 --checksums-sha256 ${enclaveRelease.checksum}`,
    );
    if (!content.includes('exec "${NODE_BIN}" "${WORKSPACE_PATH}/dist/cli.js" --build-local')) {
      installStepRegexGlobal.lastIndex = 0;
      if (!installStepRegexGlobal.test(content)) throw new Error('Missing released AWF install anchor for branch diagnostics');
      installStepRegexGlobal.lastIndex = 0;
      content = content.replace(installStepRegexGlobal, (match, indent: string) =>
        match + buildBranchEnclaveInstallSteps(indent, isCloudHypervisorAgentEnclaveSmoke));
      messages.push('  Added branch-only source runtime build for enclave diagnostics');
    }
    content = content.replace(
      /^( {6}- name: Redact secrets in logs\n)( {8}if: always\(\)\n)/gm,
      '$1        id: redact_secrets\n$2',
    );
    const invocationPairs = [
      {
        normal: 'sudo --preserve-env awf --config ',
        debug: 'sudo --preserve-env awf --cloud-hypervisor-enclave-debug-public --config ',
      },
      {
        normal: '/usr/local/bin/awf --config ',
        debug: '/usr/local/bin/awf --cloud-hypervisor-enclave-debug-public --config ',
      },
    ];
    const countOccurrences = (value: string, needle: string): number =>
      value.split(needle).length - 1;
    const normalCount = invocationPairs.reduce(
      (count, pair) => count + countOccurrences(content, pair.normal), 0);
    const debugCount = invocationPairs.reduce(
      (count, pair) => count + countOccurrences(content, pair.debug), 0);
    if (debugCount > 1 || (debugCount === 1 && normalCount > 0)) {
      throw new Error('Expected exactly one trusted host AWF invocation for public enclave debug');
    }
    if (debugCount === 0) {
      if (normalCount !== 1) {
        throw new Error('Expected exactly one trusted host AWF invocation for public enclave debug');
      }
      const pair = invocationPairs.find(({ normal }) => content.includes(normal));
      if (!pair) {
        throw new Error('Could not identify trusted host AWF invocation for public enclave debug');
      }
      content = content.replace(pair.normal, pair.debug);
      messages.push('  Enabled public enclave debug on the effective host AWF invocation');
    }
    const upload = /( {8}name: Upload public enclave debug evidence\n(?:(?! {6}-)[^\n]*\n)*? {10}retention-days: )[^\n]+/;
    if (!upload.test(content)) {
      throw new Error('Could not find the separate public enclave debug artifact retention');
    }
    content = content.replace(upload, (_match, prefix: string) => `${prefix}1`);
  }
  return { content, messages };
}
