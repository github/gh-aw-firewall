import {
  applyGeneralWorkflowPatches,
  usesPublishedAwfRelease,
} from './apply-general-workflow-patches';
import { copilotCliDaemonCopyStepSentinel } from './workflow-patch-patterns';

// The gh-aw compiler emits this step for every firewall + arc-dind workflow
// regardless of engine.id (github/gh-aw-firewall#7505), so for non-Copilot
// engines `command -v copilot` resolves empty and the `cp` fails the job.
const COMPILER_EMITTED_COPY_STEP =
  '      - name: Copy Copilot CLI to daemon-visible path\n' +
  '        run: |\n' +
  '          mkdir -p "${RUNNER_TEMP}/gh-aw/bin"\n' +
  '          COPILOT_SRC="$(command -v copilot)"\n' +
  '          cp "$COPILOT_SRC" "${RUNNER_TEMP}/gh-aw/bin/copilot"\n' +
  '          chmod +x "${RUNNER_TEMP}/gh-aw/bin/copilot"\n';

function lockFileWithEngine(engineId: string): string {
  return (
    'jobs:\n' +
    '  agent:\n' +
    '    env:\n' +
    `      GH_AW_ENGINE_ID: "${engineId}"\n` +
    '    steps:\n' +
    COMPILER_EMITTED_COPY_STEP
  );
}

describe('applyGeneralWorkflowPatches Copilot CLI copy step gating', () => {
  it('skips the copy for a non-copilot compiled engine', () => {
    const { content, log } = applyGeneralWorkflowPatches(
      lockFileWithEngine('claude'),
      '/tmp/example.lock.yml'
    );

    expect(content).toContain(copilotCliDaemonCopyStepSentinel);
    expect(content).toContain(
      'echo "Skipping Copilot CLI binary copy for non-copilot engine: claude" >&2'
    );
    expect(content).not.toContain('command -v copilot');
    expect(log.some(entry => entry.includes("compiled engine 'claude'"))).toBe(true);
  });

  it('keeps fail-fast copy behaviour for the copilot engine', () => {
    const { content } = applyGeneralWorkflowPatches(
      lockFileWithEngine('copilot'),
      '/tmp/example.lock.yml'
    );

    expect(content).toContain('COPILOT_SRC="$(command -v copilot 2>/dev/null || true)"');
    expect(content).toContain('exit 127');
    expect(content).toContain('cp "$COPILOT_SRC" "${RUNNER_TEMP}/gh-aw/bin/copilot"');
  });

  it('defaults to copilot when no engine id is present', () => {
    const { content } = applyGeneralWorkflowPatches(
      COMPILER_EMITTED_COPY_STEP,
      '/tmp/example.lock.yml'
    );

    expect(content).toContain('exit 127');
  });

  it('is idempotent across repeated postprocess runs', () => {
    const first = applyGeneralWorkflowPatches(lockFileWithEngine('claude'), '/tmp/example.lock.yml');
    const second = applyGeneralWorkflowPatches(first.content, '/tmp/example.lock.yml');
    expect(second.content).toBe(first.content);
  });
});

describe('applyGeneralWorkflowPatches published AWF maintenance workflows', () => {
  const compilerOutput =
    'jobs:\n' +
    '  agent:\n' +
    '    steps:\n' +
    '      - name: Install AWF binary\n' +
    '        run: bash "${RUNNER_TEMP}/gh-aw/actions/install_awf_binary.sh" v0.28.2\n' +
    '      - name: Run agent\n' +
    '        run: awf --image-tag 0.28.2 --skip-pull -- command\n';

  it.each([
    'auth-doctor-updater.lock.yml',
    'doc-maintainer.lock.yml',
    'model-api-mapping-updater.lock.yml',
    'sbx-gvisor-doc-updater.lock.yml',
    'schema-sync.lock.yml',
    'self-hosted-runner-doctor-updater.lock.yml',
    'update-release-notes.lock.yml',
  ])('preserves the published release for %s', workflowFile => {
    const workflowPath = `/tmp/workflows/${workflowFile}`;
    const { content, log } = applyGeneralWorkflowPatches(compilerOutput, workflowPath);

    expect(usesPublishedAwfRelease(workflowPath)).toBe(true);
    expect(content).toContain('install_awf_binary.sh" v0.28.2');
    expect(content).toContain('--image-tag 0.28.2 --skip-pull');
    expect(content).not.toContain('--build-local');
    expect(log).toContain('  Preserved published AWF binary and images for maintenance workflow');
  });

  it('continues using local builds for validation workflows', () => {
    const { content } = applyGeneralWorkflowPatches(
      compilerOutput,
      '/tmp/workflows/smoke-copilot.lock.yml'
    );

    expect(content).toContain('Install awf binary (local)');
    expect(content).toContain('--build-local');
    expect(content).not.toContain('--image-tag 0.28.2 --skip-pull');
  });

  it('allows verified release artifacts with Cloud Hypervisor local builds', () => {
    const cloudHypervisorOutput =
      compilerOutput.replace(
        'awf --image-tag 0.28.2 --skip-pull -- command',
        'awf --cloud-hypervisor-supervisor "${GH_AW_CLOUD_HYPERVISOR_SUPERVISOR}" ' +
          '--cloud-hypervisor-preview --image-tag 0.28.2 --skip-pull -- command'
      ) +
      '        env:\n' +
      '          AWF_REFLECT_ENABLED: 1\n';

    const { content, log } = applyGeneralWorkflowPatches(
      cloudHypervisorOutput,
      '/tmp/workflows/smoke-cloud-hypervisor.lock.yml'
    );

    expect(content).toContain('--build-local');
    expect(content).toContain('--cloud-hypervisor-development-allow-unattested-artifacts');
    expect(content).toContain('AWF_CLOUD_HYPERVISOR_DEVELOPMENT_ALLOW_UNATTESTED_ARTIFACTS: "1"');
    expect(content).toContain('--cloud-hypervisor-supervisor-sha256');
    expect(log).toContain('  Enabled hashed development artifacts for Cloud Hypervisor local build');
  });
});

describe('applyGeneralWorkflowPatches Cloud Hypervisor bundle retries', () => {
  const compilerOutput =
    'jobs:\n' +
    '  agent:\n' +
    '    steps:\n' +
    '      - name: Download and verify cloud-hypervisor bundle\n' +
    '        id: cloud-hypervisor-bundle\n' +
    '        env:\n' +
    '          GH_AW_AWF_VERSION: v0.28.11\n' +
    '        run: bash "${RUNNER_TEMP}/gh-aw/actions/cloud_hypervisor_setup_bundle.sh"\n' +
    '      - name: Setup Node.js\n' +
    '        run: echo setup\n';

  it('wraps generated bundle setup with bounded retries', () => {
    const { content, log } = applyGeneralWorkflowPatches(
      compilerOutput,
      '/tmp/workflows/smoke-cloud-hypervisor.lock.yml'
    );

    expect(content).toContain('setup_status=0');
    expect(content).toContain('for attempt in 1 2 3; do');
    expect(content).toMatch(/\n\s+else\n\s+setup_status=\$\?/);
    expect(content).toContain('sleep $((attempt * 10))');
    expect(content).toContain('exit "$setup_status"');
    expect(content).not.toContain(
      'run: bash "${RUNNER_TEMP}/gh-aw/actions/cloud_hypervisor_setup_bundle.sh"'
    );
    expect(log).toContain(
      '  Wrapped 1 Cloud Hypervisor bundle setup step(s) with retries'
    );
  });

  it('is idempotent for an already wrapped bundle setup step', () => {
    const first = applyGeneralWorkflowPatches(
      compilerOutput,
      '/tmp/workflows/smoke-cloud-hypervisor.lock.yml'
    );
    const second = applyGeneralWorkflowPatches(
      first.content,
      '/tmp/workflows/smoke-cloud-hypervisor.lock.yml'
    );

    expect(second.content).toBe(first.content);
    expect(second.content.match(/setup_status=0/g)).toHaveLength(1);
  });
});

describe('applyGeneralWorkflowPatches shared enclave gateway policy', () => {
  it('normalizes the generated shared gateway handoff', () => {
    const compiled =
      '              "safeoutputs": {"type": "stdio"},\n' +
      '              "GITHUB_TOOLSETS": "context"\n' +
      '              "awf-enclave": {\n' +
      '                "type": "http",\n' +
      '              "github": {\n' +
      '              "type": "stdio",\n' +
      '              "agentPolicies": {"primary":{"servers":["github","safe-outputs"]}},\n' +
      '                  "min-integrity": "$GITHUB_MCP_GUARD_MIN_INTEGRITY",\n' +
      '                  "repos": "$GITHUB_MCP_GUARD_REPOS"\n' +
      '      - name: Execute GitHub Copilot CLI\n' +
      '        env:\n' +
      '          AWF_REFLECT_ENABLED: 1\n' +
      '        run: awf --exclude-env MCP_GATEWAY_AGENT_ID\n';

    const { content, log } = applyGeneralWorkflowPatches(
      compiled,
      '/tmp/workflows/smoke-enclave-issues-read.lock.yml'
    );

    expect(content).toContain('"safeoutputs": {"type": "stdio"}');
    expect(content).toContain('"servers":["github","safeoutputs"]');
    expect(content).toContain('"GITHUB_TOOLSETS": "context,issues"');
    expect(content).toContain('"min-integrity": "approved"');
    expect(content).toContain('"repos": ["github/gh-aw"]');
    expect(content).toContain(
      '"github": {\n              "required": false,\n              "type": "stdio"'
    );
    expect(content).toContain(
      'GH_TOKEN: ${{ secrets.GH_AW_GITHUB_MCP_SERVER_TOKEN || secrets.GH_AW_GITHUB_TOKEN || secrets.GITHUB_TOKEN }}'
    );
    expect(content).toContain('--exclude-env GH_TOKEN');
    expect(content).toContain('"awf-enclave": {\n                "required": false,');
    expect(content).not.toContain('"servers":["github","safe-outputs"]');
    expect(log).toContain('  Normalized shared-gateway policy, server IDs, and toolsets');
  });

  it('deduplicates compiler-provided gateway authentication', () => {
    const gatewayKey =
      '          MCP_GATEWAY_API_KEY: ${{ steps.start-mcp-gateway.outputs.gateway-api-key }}';
    const compiled = [
      '              "awf-enclave": {',
      '                "type": "http",',
      '      - name: Execute GitHub Copilot CLI',
      '        env:',
      gatewayKey,
      '          AWF_REFLECT_ENABLED: 1',
      gatewayKey,
      '          RUNNER_TEMP: ${{ runner.temp }}',
      '      - name: Detect agent errors',
    ].join('\n');

    const { content, log } = applyGeneralWorkflowPatches(
      compiled,
      '/tmp/workflows/smoke-enclave-issues-read.lock.yml'
    );

    expect(content.split(gatewayKey).length - 1).toBe(1);
    expect(log).toContain(
      '  Removed duplicate gateway API key entries from enclave smoke agent environment'
    );
  });
});
