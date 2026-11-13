import { applyGeneralWorkflowPatches, usesPublishedAwfRelease } from '../apply-general-workflow-patches';
import * as facade from '../workflow-patch-patterns';
import * as installPatterns from './network-and-install-patterns';
import * as enginePatterns from './engine-lifecycle-patterns';
import * as cachePatterns from './cache-memory-patterns';
import * as session from './session-state';
import * as concurrency from './concurrency';
import { configureNpmFeed, installLocalAwf } from './network-and-install';
import { gateEngineLifecycle } from './engine-lifecycle';
import { excludeAuditorCredentials, excludeAzureCredentials, restrictRecoveryRoots } from './credentials';
import { hardenCacheMemory, restrictDiagnosisCacheContext } from './cache-memory';
import { configureEnclaveReadiness, configureEnclaveDiagnostics } from './enclave';
import { declareDisabledAdmissionOutputs } from './admission';
import type { PatchContext } from './types';

const context = (workflowPath: string): PatchContext => ({
  workflowPath, workflowFile: workflowPath.split(/[/\\]/).pop(),
});
const copyStep =
  '      - name: Copy Copilot CLI to daemon-visible path\n' +
  '        run: |\n' +
  '          mkdir -p "${RUNNER_TEMP}/gh-aw/bin"\n' +
  '          COPILOT_SRC="$(command -v copilot)"\n' +
  '          cp "$COPILOT_SRC" "${RUNNER_TEMP}/gh-aw/bin/copilot"\n' +
  '          chmod +x "${RUNNER_TEMP}/gh-aw/bin/copilot"\n';
const cacheSteps =
  '      - name: Setup cache-memory git repository\n' +
  '        run: bash "${RUNNER_TEMP}/gh-aw/actions/setup_cache_memory_git.sh"\n' +
  '      - name: Commit cache-memory changes\n' +
  '        run: bash "${RUNNER_TEMP}/gh-aw/actions/commit_cache_memory_git.sh"\n';
const installStep =
  '      - name: Install awf binary\n' +
  '        run: bash "${RUNNER_TEMP}/gh-aw/actions/install_awf_binary.sh" v0.28.66\n';

describe('standalone workflow patch domains', () => {
  it('only adds approved npm access to exact registry hosts and is idempotent', () => {
    const restricted = String.raw`echo "{\"allowDomains\":[\"registry.npmjs.org.attacker.example\"]}"`;
    expect(configureNpmFeed(restricted)).toEqual({ content: restricted, messages: [] });
    const input = 'env:\n' + String.raw`echo "{\"allowDomains\":[\"registry.npmjs.org\"]}"`;
    const first = configureNpmFeed(input);
    expect(first.content).toContain(String.raw`\"packagefeedproxy.microsoft.io\",\"registry.npmjs.org\"`);
    expect(configureNpmFeed(first.content).content).toBe(first.content);
  });

  it('keeps unconditional credential-free checkout and preserves non-AWF tool images', () => {
    const input = 'jobs:\n  agent:\n    steps:\n' +
      '      - name: Checkout repository for patch context\n        if: false\n' +
      installStep + '      - run: awf --skip-pull\n' +
      '      - run: docker pull ghcr.io/github/gh-aw-firewall/agent:0.28.66 ' +
      'ghcr.io/github/gh-aw-mcpg:v0.4.36@sha256:' + 'a'.repeat(64) + '\n';
    const first = installLocalAwf(input, context('/repo/example.lock.yml'));
    expect(first.content).toContain('persist-credentials: false');
    expect(first.content).toContain('ghcr.io/github/gh-aw-mcpg:v0.4.36@sha256:');
    expect(first.content).not.toContain('ghcr.io/github/gh-aw-firewall/agent:');
    expect(installLocalAwf(first.content, context('/repo/example.lock.yml')).content).toBe(first.content);
    expect(installLocalAwf(installStep, context('C:\\repo\\auth-doctor-updater.lock.yml')).content).toBe(installStep);
  });

  it('collects both session invocation shapes without duplicate flags or legacy log paths', () => {
    const input = 'awf --audit-dir /tmp/gh-aw/sandbox/firewall/audit\n' +
      'awf --config "${RUNNER_TEMP}/gh-aw/awf-config.json"\n' +
      '/tmp/gh-aw/sandbox/firewall/logs/api-proxy\n';
    const first = session.collectSessionState(input);
    expect(first.messages).toHaveLength(3);
    expect(first.content.split(`--session-state-dir ${session.SESSION_STATE_DIR}`)).toHaveLength(3);
    expect(first.content).toContain('/logs/api-proxy-logs');
    expect(session.collectSessionState(first.content).content).toBe(first.content);
  });

  it('gates non-Copilot copies and disables only Codex lifecycle scripts', () => {
    const input = 'GH_AW_ENGINE_ID: "claude"\n' + copyStep +
      'run: npm install -g @openai/codex@1.2.3\n' +
      'run: npm install -g @anthropic-ai/claude-code@1.2.3\n';
    const first = gateEngineLifecycle(input);
    expect(first.content).toContain('npm install --ignore-scripts -g @openai/codex');
    expect(first.content).toContain('run: npm install -g @anthropic-ai/claude-code');
    expect(first.messages[0]).toContain("compiled engine 'claude'");
    expect(gateEngineLifecycle(first.content).content).toBe(first.content);
    const other = gateEngineLifecycle(input.replace('"claude"', '"codex"'));
    expect(other.messages[0]).toContain("compiled engine 'codex'");
  });

  it('preserves fail-closed auditor checks and scopes runner-only credential exclusions', () => {
    const auditor = context('/repo/workflow-runtime-auditor.lock.yml');
    const command = 'awf --config config.json --env-all\n';
    expect(() => excludeAuditorCredentials(command, auditor)).toThrow('Expected both AWF sandbox commands');
    const first = excludeAuditorCredentials(command.repeat(2), auditor);
    expect(first.content.match(/--exclude-env GH_AW_DEFAULT_OTLP_HEADERS/g)).toHaveLength(2);
    expect(excludeAuditorCredentials(first.content, auditor).content).toBe(first.content);
    const oidc = '--exclude-env ACTIONS_ID_TOKEN_REQUEST_TOKEN --exclude-env ACTIONS_ID_TOKEN_REQUEST_URL';
    const azure = context('/repo/smoke-copilot-byok-aoai-entra.lock.yml');
    const excluded = excludeAzureCredentials(oidc, azure);
    expect(excluded.content).toContain('--exclude-env AWF_AUTH_AZURE_TENANT_ID');
    expect(excludeAzureCredentials(excluded.content, azure).content).toBe(excluded.content);
    expect(excludeAzureCredentials(oidc, context('/repo/example.lock.yml')).content).toBe(oidc);
    const roots = 'GH_AW_RECOVERY_ADDITIONAL_ROOTS: \'["/tmp/gh-aw","/tmp/gh-aw/agent_output.json"]\'\n';
    expect(restrictRecoveryRoots(roots, context('C:\\repo\\self-hosted-runner-doctor-updater.lock.yml')).content)
      .toBe('GH_AW_RECOVERY_ADDITIONAL_ROOTS: \'["/tmp/gh-aw/agent_output.json"]\'\n');
  });

  it('hardens cache files before reuse and quarantines injection content idempotently', () => {
    const workflow = context('/repo/example.lock.yml');
    const first = hardenCacheMemory(cacheSteps, workflow);
    expect(first.content).toContain('chmod a-x');
    expect(first.content).toContain('/.quarantine');
    expect(first.content).toContain("also match the explicit '<system>' instruction tag");
    expect(first.content.indexOf(cachePatterns.scanInjectionStepSentinel))
      .toBeLessThan(first.content.indexOf('- name: Commit cache-memory changes'));
    expect(hardenCacheMemory(first.content, workflow).content).toBe(first.content);
    expect(restrictDiagnosisCacheContext(
      'copilot --add-dir /tmp/gh-aw/cache-memory/ --model test',
      context('C:\\repo\\network-doctor-updater.lock.yml'),
    ).content).toBe('copilot --model test');
  });

  it('keeps concurrency substring matching, per-issue scoping, and diagnostic warnings', () => {
    const workflow = context('/repo/issue-duplication-detector.lock.yml.backup');
    const input = '      group: "gh-aw-conclusion-issue-duplication-detector"\n' +
      '      cancel-in-progress: false\n';
    const first = concurrency.scopeConclusionConcurrency(input, workflow);
    expect(first.content).toContain('${{ github.event.issue.number || github.run_id }}');
    expect(concurrency.scopeConclusionConcurrency(first.content, workflow).content).toBe(first.content);
    expect(concurrency.scopeConclusionConcurrency('', workflow).messages[0]).toContain('WARNING:');
    expect(concurrency.scopeConclusionConcurrency(input, context('/repo/example.lock.yml')).content).toBe(input);
  });

  it('does not silently bypass missing admission or enclave security anchors', () => {
    expect(() => declareDisabledAdmissionOutputs(
      '# gh-aw-manifest: {"admission":false}\nneeds.activation.outputs.admission-result\n',
      context('/repo/example.lock.yml'),
    )).toThrow('Missing activation outputs');
    expect(() => configureEnclaveReadiness('', context('/repo/smoke-enclave-issues-read.lock.yml')))
      .toThrow('Could not find the enclave MCP backend');
    expect(() => configureEnclaveReadiness(
      '"awf-enclave": {\n                "required": false,\n' +
      '      - name: Execute GitHub Copilot CLI\n        env:\n          FOO: bar\n',
      context('/repo/smoke-enclave-issues-read.lock.yml'),
    )).toThrow('missing MCP_GATEWAY_API_KEY exclusion anchor');
    expect(() => configureEnclaveDiagnostics(
      installStep + 'exec "${NODE_BIN}" "${WORKSPACE_PATH}/dist/cli.js" --build-local\n' +
      'sudo --preserve-env awf --config x\n/usr/local/bin/awf --config y\n',
      context('/repo/smoke-enclave-cloud-hypervisor.lock.yml'),
    )).toThrow('Expected exactly one trusted host AWF invocation');
  });
});

describe('ordered workflow pipeline compatibility', () => {
  it('retains shared regex identities through the old patterns export surface', () => {
    for (const owner of [installPatterns, enginePatterns, cachePatterns, session, concurrency]) {
      for (const [name, value] of Object.entries(owner)) {
        if (name !== 'collectSessionState' && name !== 'scopeConclusionConcurrency') {
          expect(Reflect.get(facade, name)).toBe(value);
        }
      }
    }
    expect(usesPublishedAwfRelease('C:\\repo\\auth-doctor-updater.lock.yml')).toBe(true);
    expect(usesPublishedAwfRelease('/repo/not-auth-doctor-updater.lock.yml')).toBe(false);
  });

  it('hands off updated content and preserves interleaved domain log order', () => {
    const input = 'env:\n  EXISTING: value\n' +
      '# gh-aw-manifest: {"admission":false}\n' +
      'jobs:\n  activation:\n    outputs:\n      existing: value\n' +
      '  agent:\n    env:\n      GH_AW_ENGINE_ID: "claude"\n' +
      '      RESULT: ${{ needs.activation.outputs.admission-result }}\n    steps:\n' +
      installStep + '      - run: awf --config "${RUNNER_TEMP}/gh-aw/awf-config.json" --allow-all-tools\n' +
      copyStep + '      group: "gh-aw-conclusion-issue-duplication-detector"\n' +
      '      cancel-in-progress: false\n' + cacheSteps;
    const workflowPath = '/repo/smoke-copilot.lock.yml/issue-duplication-detector.lock.yml';
    const result = applyGeneralWorkflowPatches(input, workflowPath);
    expect(result.log).toEqual([
      '  Configured the Microsoft-approved npm feed for all jobs',
      '  Declared empty optional outputs for disabled admission',
      '  Replaced 1 awf install step(s) with local build',
      '  Injected 1 checkout step(s) before awf build steps',
      '  Injected --session-state-dir in 1 awf --config invocation(s)',
      "  Gated 1 'Copy Copilot CLI to daemon-visible path' step(s) on compiled engine 'claude'",
      '  Scoped conclusion concurrency group to per-issue for issue-duplication-detector',
      '  Injected --excluded-tools (21 browser tools) in 1 location(s)',
      "  Injected 'Strip execute bits' step after cache-memory setup",
      "  Injected 'Scan cache-memory for instruction-injection' step before commit",
    ]);
    expect(result.content).toContain('admission-result: ""');
    expect(result.content).toContain('--excluded-tools=browser_close');
    expect(applyGeneralWorkflowPatches(result.content, workflowPath).content).toBe(result.content);
  });

  it('does not leak global-regex state across successive different workflows', () => {
    const input = installStep + 'awf --config "${RUNNER_TEMP}/gh-aw/awf-config.json"\n' + copyStep;
    const first = applyGeneralWorkflowPatches(input, '/repo/first.lock.yml');
    applyGeneralWorkflowPatches('', 'C:\\repo\\auth-doctor-updater.lock.yml');
    const second = applyGeneralWorkflowPatches(input, '/repo/second.lock.yml');
    expect(second).toEqual(first);
  });
});
