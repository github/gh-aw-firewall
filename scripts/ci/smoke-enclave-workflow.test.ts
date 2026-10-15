import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as yaml from 'js-yaml';
import { applyGeneralWorkflowPatches } from './apply-general-workflow-patches';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const sourcePath = path.join(workflowsDir, 'smoke-enclave-build-test.md');
const lockPath = path.join(workflowsDir, 'smoke-enclave-build-test.lock.yml');
const issuesSourcePath = path.join(workflowsDir, 'smoke-enclave-issues-read.md');
const issuesLockPath = path.join(workflowsDir, 'smoke-enclave-issues-read.lock.yml');
const dynamicSourcePath = path.join(workflowsDir, 'smoke-enclave-dynamic-issues-read.md');
const dynamicLockPath = path.join(workflowsDir, 'smoke-enclave-dynamic-issues-read.lock.yml');

function countOccurrences(content: string, value: string): number {
  return content.split(value).length - 1;
}

describe('experimental Cloud Hypervisor enclave smoke workflow', () => {
  const source = fs.readFileSync(
    path.join(workflowsDir, 'smoke-enclave-cloud-hypervisor.md'), 'utf8'
  );
  const workflowPath = path.join(workflowsDir, 'smoke-enclave-cloud-hypervisor.lock.yml');
  const lock = fs.readFileSync(workflowPath, 'utf8');

  it('provides the staging token to the trusted host without exposing it to the agent', () => {
    const compiled = yaml.load(lock) as {
      env?: Record<string, unknown>;
      jobs: Record<string, {
        env?: Record<string, unknown>;
        permissions?: Record<string, string>;
        steps?: Array<{
          name?: string;
          env?: Record<string, unknown>;
          run?: string;
        }>;
      }>;
    };
    const agent = compiled.jobs.agent;
    const executeAgent = agent.steps?.find(step =>
      step.name === 'Execute GitHub Copilot CLI');
    const configureGh = agent.steps?.find(step =>
      step.name === 'Configure gh CLI for GitHub Enterprise');

    expect(compiled.env?.GH_TOKEN).toBeUndefined();
    expect(agent.env?.GH_TOKEN).toBeUndefined();
    expect(executeAgent?.env?.GH_TOKEN).toBe('${{ github.token }}');
    expect(executeAgent?.env?.GITHUB_TOKEN).toBeUndefined();
    expect(executeAgent?.run).toContain('--exclude-env GH_TOKEN');
    expect(executeAgent?.run).toContain('--exclude-env COPILOT_GITHUB_TOKEN');
    expect(configureGh?.env?.GH_TOKEN).toBe('${{ github.token }}');
    expect(agent.permissions?.issues).not.toBe('write');
    expect(source).toContain('env:\n    GH_TOKEN: ${{ github.token }}');
  });

  it('omits issue-creation tools, reporters, and permissions', () => {
    const frontmatter = yaml.load(source.split('---')[1]) as {
      'safe-outputs': {
        'create-issue'?: unknown;
        'github-token': string;
        'report-failure-as-issue': boolean;
        'report-failed-jobs': boolean;
        'report-incomplete': { 'create-issue': boolean };
        'missing-tool': { 'create-issue': boolean };
        jobs: Record<string, unknown>;
      };
    };
    const compiled = yaml.load(lock) as {
      jobs: Record<string, {
        if?: string;
        permissions?: Record<string, string>;
        steps: Array<{
          name: string;
          if?: string;
          env?: Record<string, string>;
          with?: Record<string, string>;
          run?: string;
        }>;
      }>;
    };
    const failureStep = compiled.jobs.conclusion.steps.find(step =>
      step.name === 'Handle agent failure');
    const loadOutputsStep = compiled.jobs.conclusion.steps.find(step =>
      step.env?.GH_AW_REPORT_INCOMPLETE_CREATE_ISSUE !== undefined);

    expect(frontmatter['safe-outputs']['create-issue']).toBeUndefined();
    expect(frontmatter['safe-outputs'].jobs['report-smoke-result']).toBeDefined();
    expect(frontmatter['safe-outputs']['github-token']).toBe('${{ secrets.GITHUB_TOKEN }}');
    expect(frontmatter['safe-outputs']['report-failure-as-issue']).toBe(false);
    expect(frontmatter['safe-outputs']['report-failed-jobs']).toBe(false);
    expect(frontmatter['safe-outputs']['report-incomplete']['create-issue']).toBe(false);
    expect(frontmatter['safe-outputs']['missing-tool']['create-issue']).toBe(false);
    expect(failureStep).toBeDefined();
    expect(failureStep?.env?.GH_AW_FAILURE_REPORT_AS_ISSUE).toBe('false');
    expect(failureStep?.env?.GH_AW_MISSING_DATA_REPORT_AS_FAILURE).toBe('true');
    expect(failureStep?.env?.GH_AW_MISSING_TOOL_REPORT_AS_FAILURE).toBe('true');
    expect(compiled.jobs.conclusion.steps.some(step =>
      step.name === 'Report failed jobs')).toBe(false);
    const missingToolStep = compiled.jobs.conclusion.steps.find(step =>
      step.env?.GH_AW_MISSING_TOOL_CREATE_ISSUE !== undefined);
    expect(missingToolStep?.env?.GH_AW_MISSING_TOOL_CREATE_ISSUE).toBe('false');
    expect(loadOutputsStep?.env?.GH_AW_REPORT_INCOMPLETE_CREATE_ISSUE).toBe('false');
    expect(compiled.jobs.conclusion.permissions?.issues).toBeUndefined();
    expect(Object.entries(compiled.jobs)
      .filter(([, job]) => job.permissions?.issues === 'write')
      .map(([name]) => name)).toEqual([]);
    expect(compiled.jobs.safe_outputs.permissions?.issues).toBeUndefined();
    expect(compiled.jobs.report_smoke_result.permissions?.issues).toBeUndefined();
    const blockedVersionStep = compiled.jobs.activation.steps.find(step =>
      step.env?.GH_AW_BLOCKED_VERSION_REPORT_AS_ISSUE !== undefined);
    expect(blockedVersionStep?.env?.GH_AW_BLOCKED_VERSION_REPORT_AS_ISSUE).toBe('false');
    for (const configKey of [
      'GH_AW_SAFE_OUTPUTS_CONFIG', 'GH_AW_SAFE_OUTPUTS_HANDLER_CONFIG',
    ]) {
      const configStep = Object.values(compiled.jobs).flatMap(job => job.steps)
        .find(step => step.env?.[configKey] !== undefined);
      const config = JSON.parse(configStep?.env?.[configKey] ?? '{}') as {
        create_issue?: unknown;
        missing_data?: { create_issue?: string };
        create_report_incomplete_issue?: unknown;
        report_incomplete?: unknown;
      };
      expect(config.create_issue).toBeUndefined();
      expect(config.missing_data?.create_issue).toBeUndefined();
      expect(config.create_report_incomplete_issue).toBeUndefined();
      expect(config.report_incomplete).toEqual({});
    }
    const manifestLine = lock.split('\n').find(line =>
      line.startsWith('# gh-aw-manifest: '));
    expect(manifestLine).toBeDefined();
    const manifest = JSON.parse(manifestLine!.slice('# gh-aw-manifest: '.length)) as {
      mcp_servers: Array<{ name: string; tools: string[] }>;
    };
    const safeOutputsTools = manifest.mcp_servers.find(server =>
      server.name === 'safeoutputs')?.tools ?? [];
    expect(safeOutputsTools).not.toContain('create_issue');
    expect(safeOutputsTools).toContain('report_smoke_result');
    expect(safeOutputsTools).toContain('missing_data');
    for (const name of [
      'Append agent step summary',
      'Parse agent logs for step summary',
      'Generate observability summary',
      'Validate enclave invocation and result',
    ]) {
      expect(compiled.jobs.agent.steps.find(step => step.name === name)?.if)
        .toBe('always()');
    }
    expect(lock).toContain('name: Upload Safe Outputs Items\n        if: always()');
    expect(source).toContain('safeoutputs report_smoke_result .');
    const processSafeOutputs = compiled.jobs.safe_outputs.steps.find(step =>
      step.name === 'Process Safe Outputs');
    expect(processSafeOutputs?.with?.['github-token']).toBe('${{ secrets.GITHUB_TOKEN }}');
    expect(source).toContain('The ordinary `create_issue` tool, failed-jobs issue reporter');
    expect(source).toContain('the generated workflow grants no job `issues: write`');

    const reportJob = compiled.jobs.report_smoke_result;
    const reportStep = reportJob.steps.find(step =>
      step.name === 'Record enclave result');
    expect(reportJob.if).toContain("needs.agent.result == 'success'");
    expect(reportStep?.run).toContain(
      `ENCLAVE_CLOUD_HYPERVISOR_PASS {"package_json":true,"src":true}`
    );
    expect(reportStep?.env?.SMOKE_RESULT).toBeUndefined();
    expect(reportStep?.run).not.toContain('inputs.result');
  });

  it('gates the fixed PASS summary on the exact successful result and no diagnostics', () => {
    const frontmatter = yaml.load(source.split('---')[1]) as {
      'post-steps': Array<{ name: string; if?: string; run: string }>;
    };
    const compiled = yaml.load(lock) as {
      jobs: Record<string, {
        if?: string;
        steps: Array<{ name: string; if?: string; run?: string }>;
        'timeout-minutes'?: number;
      }>;
    };
    const validateStep = frontmatter['post-steps'].find(step =>
      step.name === 'Validate enclave invocation and result');
    const compiledValidateStep = compiled.jobs.agent.steps.find(step =>
      step.name === 'Validate enclave invocation and result');
    expect(validateStep?.if).toBe('always()');
    expect(compiledValidateStep?.if).toBe('always()');
    expect(validateStep?.run).toContain('record.kind === "failure"');
    expect(validateStep?.run).toContain('record.type === "missing_data"');
    expect(validateStep?.run).toContain('record.type === "missing_tool"');
    expect(validateStep?.run).toContain('results.length !== 1');
    expect(compiled.jobs.report_smoke_result.if)
      .toContain("needs.agent.result == 'success'");

    const tempDir = fs.mkdtempSync(path.join(__dirname, 'smoke-enclave-validation-'));
    const auditPath = path.join(tempDir, 'audit.jsonl');
    const outputsPath = path.join(tempDir, 'outputs.jsonl');
    const audit = [{ kind: 'invocation', repo: 'github/gh-aw-firewall', sensitivity: 'public' }];
    const expectedOutput = {
      type: 'report_smoke_result',
      result: 'ENCLAVE_CLOUD_HYPERVISOR_PASS {"package_json":true,"src":true}',
    };
    const validate = (outputs: unknown[], auditRecords: unknown[] = audit) => {
      fs.writeFileSync(auditPath, `${auditRecords.map(value => JSON.stringify(value)).join('\n')}\n`);
      fs.writeFileSync(outputsPath, `${outputs.map(value => JSON.stringify(value)).join('\n')}\n`);
      return execFileSync('bash', ['-c', validateStep!.run], {
        encoding: 'utf8',
        env: { ...process.env, AUDIT_LOG: auditPath, OUTPUTS_FILE: outputsPath },
        stdio: 'pipe',
      });
    };

    try {
      expect(() => validate([expectedOutput])).not.toThrow();
      for (const diagnosticType of ['missing_data', 'missing_tool']) {
        expect(() => validate([
          expectedOutput,
          { type: diagnosticType, reason: 'contradictory failure diagnostic' },
        ])).toThrow();
      }
      expect(() => validate([
        expectedOutput,
        { type: 'report_smoke_result', result: 'different result' },
      ])).toThrow();
      expect(() => validate([
        { ...expectedOutput, result: 'different result' },
      ])).toThrow();
      expect(() => validate([
        expectedOutput,
      ], [
        ...audit,
        { kind: 'failure', repo: 'github/gh-aw-firewall', sensitivity: 'public' },
      ])).toThrow();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('sets both agent retry budgets to zero and bounds individual jobs', () => {
    const compiled = yaml.load(lock) as {
      'timeout-minutes'?: number;
      jobs: Record<string, {
        'timeout-minutes'?: number;
        steps: Array<{
          name: string;
          env?: Record<string, string>;
          run?: string;
        }>;
      }>;
    };
    const executeAgent = compiled.jobs.agent.steps.find(step =>
      step.name === 'Execute GitHub Copilot CLI');

    expect(compiled.jobs.agent['timeout-minutes']).toBe(20);
    expect(compiled.jobs.safe_outputs['timeout-minutes']).toBe(20);
    expect(compiled['timeout-minutes']).toBeUndefined();
    for (const [name, job] of Object.entries(compiled.jobs)) {
      expect(job['timeout-minutes']).toBe(
        ['agent', 'safe_outputs'].includes(name) ? 20 : undefined
      );
    }
    expect(executeAgent?.env?.GH_AW_HARNESS_STARTUP_RETRIES).toBe(0);
    expect(executeAgent?.env?.GH_AW_HARNESS_MAX_RETRIES).toBe(0);
    expect(executeAgent?.run).toContain('run_awf_with_startup_retries.sh');
    expect(executeAgent?.run).toContain('copilot_harness.cjs');
    expect(source).toContain('GH_AW_HARNESS_STARTUP_RETRIES: "0"');
    expect(source).toContain('GH_AW_HARNESS_MAX_RETRIES: "0"');
  });

  it('is manual-only and explicitly experimental on a supported runner', () => {
    expect(source).toContain('workflow_dispatch:');
    expect(source).not.toContain('schedule:');
    expect(source).toContain('(Experimental)');
    expect(source).toContain('runs-on: ubuntu-24.04');
    expect(lock).toContain('runs-on: ubuntu-24.04');
  });

  it('selects the same Cloud Hypervisor backend for the primary and static script enclave', () => {
    expect(source).toContain('version: v0.28.58\n    runtime: cloud-hypervisor');
    expect(source).toContain('runtime: cloud-hypervisor');
    expect(lock).toContain('\\"runtime\\":\\"cloud-hypervisor\\"');
    expect(lock).toContain('--container-runtime cloud-hypervisor');
    expect(lock).not.toContain('--container-runtime docker');
    expect(lock).toContain('\\"cloudHypervisor\\":{\\"previewEnabled\\":true');
    expect(lock).toContain('--exclude-env AWF_CLOUD_HYPERVISOR_ENCLAVE_SCRIPT_ROOTFS');
    expect(lock).toContain('"compiler_version":"v0.91.12"');
  });

  it('pins the published AWF and its attested artifacts to the same release', () => {
    expect(lock).toContain('install_awf_binary.sh" v0.28.58');
    expect(lock).toContain('GH_AW_AWF_VERSION: v0.28.58');
    expect(lock).toContain('https://github.com/github/gh-aw-firewall/releases/download/v0.28.58/awf-config.schema.json');
    expect(lock).toContain('Download and verify cloud-hypervisor enclave artifacts');
    expect(lock).toContain('cloud_hypervisor_setup_enclave_artifacts.sh');
    expect(lock).not.toContain('Install awf binary (local)');
    expect(lock).not.toContain('--build-local');
    expect(source).not.toContain('Do not dispatch this update yet');
    expect(source).toContain('installed host\nbinary authorizes this path');
    expect(source).toContain('Do not retag v0.28.58 or bypass the acceptance gate.');
    expect(source).toContain('diagnostics (#9898)');
    expect(source).toContain('durable host-executor\ndiagnostics (#9955)');
    expect(source).toContain('After this update merges to `main`');
    expect(source).toContain('### Remaining manual dispatch prerequisite');
    expect(source).toContain('No further release or retag is required');
    expect(source).toContain('separate live-run\nauthorization');
    expect(source).toContain('gh aw run smoke-enclave-cloud-hypervisor --ref main');
  });

  it('uses one real gateway with late enclave discovery and host authentication', () => {
    expect(countOccurrences(lock, '- name: Start MCP Gateway')).toBe(1);
    expect(lock).toContain('ghcr.io/github/gh-aw-mcpg:');
    expect(lock).toContain(
      'ghcr.io/github/gh-aw-mcpg:v0.4.30@sha256:ab5a436a1490438db473e4e3d4c973cb1d75e3cb233fb08b73d31b42d7d18fba'
    );
    expect(lock).toContain('"awf-enclave": {\n                "required": false,');
    expect(lock).toContain('GH_AW_MCP_DEFERRED_SERVERS="awf-enclave"');
    expect(lock).toContain('AWF_ENCLAVE_MCP_READINESS_TIMEOUT_MS="120000"');
    expect(lock).toContain(
      'MCP_GATEWAY_API_KEY: ${{ steps.start-mcp-gateway.outputs.gateway-api-key }}'
    );
    expect(lock).toContain('--exclude-env MCP_GATEWAY_API_KEY');
    expect(lock).not.toContain('cloud-hypervisor-enclave-gateway.js');
  });

  it('sets up release-matched primary and script-role artifacts', () => {
    expect(lock).toContain('cloud_hypervisor_setup_bundle.sh');
    expect(lock).toContain('GH_AW_AWF_VERSION: v0.28.58');
    expect(lock).toContain('cloud_hypervisor_setup_enclave_artifacts.sh');
    expect(lock).toContain(
      'GH_AW_AWF_VERSION: ${{ steps.cloud-hypervisor-bundle.outputs.release_tag }}'
    );
    expect(lock).toContain('ghcr.io/github/gh-aw-firewall/enclave-script:0.28.58');
    expect(lock).toContain('ghcr.io/github/gh-aw-firewall/enclave-mcp-server:0.28.58');
    expect(lock).toContain('AWF_CLOUD_HYPERVISOR_ENCLAVE_SCRIPT_ROOTFS');
    const primarySetup = lock.slice(
      lock.indexOf('      - name: Download and verify cloud-hypervisor bundle'),
      lock.indexOf('      - name: Install AWF binary')
    );
    expect(primarySetup).toContain('GH_AW_AWF_VERSION: v0.28.58');
    expect(primarySetup).toContain(
      'GH_AW_AWF_VERSION: ${{ steps.cloud-hypervisor-bundle.outputs.release_tag }}'
    );
  });

  it('keeps every first-party image digest pinned to the binary release', () => {
    // Official v0.28.58 release asset: containers.txt.
    const releaseDigests: Record<string, string> = {
      agent: 'sha256:563f836617e23b97591971059d0ed93067a3397b599daa79249257e0a430eb7d',
      'api-proxy': 'sha256:a47f00f8f52b40cc0708dd928f0e2cde18d55ab646de599d7b88ef704d303715',
      'enclave-mcp-server': 'sha256:7b1d20b9111ba5db37a8abaa5fd2cf419b91d5d11a67a3a58bf670d0a9a5be8c',
      'enclave-script': 'sha256:c7d14c602309ba8b4b5c9e32dd3a9890af57992c2604bd93927c4d8c4547fcdc',
      squid: 'sha256:545267d0f175e9967fac2f3379de9cadad742ac7593cbda353b2f9e5bbf57692',
    };
    const manifestLine = lock.split('\n').find(line => line.startsWith('# gh-aw-manifest: '));
    if (!manifestLine) {
      throw new Error('Missing compiled workflow manifest');
    }
    const manifest = JSON.parse(manifestLine.slice('# gh-aw-manifest: '.length)) as {
      containers: Array<{ image: string; digest: string; pinned_image: string }>;
    };
    const awfImages = manifest.containers.filter(container =>
      container.image.startsWith('ghcr.io/github/gh-aw-firewall/')
    );
    expect(awfImages.map(container => container.image.split('/').pop()).sort()).toEqual([
      'agent:0.28.58', 'api-proxy:0.28.58', 'enclave-mcp-server:0.28.58',
      'enclave-script:0.28.58', 'squid:0.28.58',
    ]);
    for (const container of awfImages) {
      const name = container.image.split('/').pop()!.split(':')[0];
      expect(container.digest).toBe(releaseDigests[name]);
      expect(container.pinned_image).toBe(`${container.image}@${releaseDigests[name]}`);
      expect(container.pinned_image).toMatch(
        new RegExp(`^${container.image.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}@sha256:[a-f0-9]{64}$`)
      );
      expect(lock).toContain(container.pinned_image);
    }
    expect(lock).toContain('\\"imageTag\\":\\"0.28.58,');
    expect(lock).not.toMatch(/0\.28\.(51|52|53|54|55|56|57)/);
    expect(source).not.toContain('v0.28.56');
  });

  it('requires an audited invocation and exact successful output', () => {
    expect(source).toContain('repo: github/gh-aw-firewall\n        sensitivity: public');
    expect(source).toContain('no Docker enclave fallback is permitted');
    expect(source).toContain("uses AWF's finite-disclosure schema algebra, not JSON");
    expect(source).toContain('"package_json": { "type": "boolean" }');
    expect(source).toContain('"src": { "type": "boolean" }');
    const toolCommandMatch = source.match(
      /```bash\n(awf-enclave enclave_run_script \. <<'JSON'\n[\s\S]*?\nJSON)\n```/
    );
    if (!toolCommandMatch) {
      throw new Error('Missing the exact mounted enclave CLI command');
    }
    const toolInput = JSON.parse(execFileSync('bash', ['-c',
      'function awf-enclave() { [[ "$#" == 2 && "$1" == enclave_run_script && "$2" == . ]] || return 1; cat; }\n' +
      toolCommandMatch[1],
    ], { encoding: 'utf8' })) as {
      privateRepo: string;
      schema: { type: string; fields: Record<string, { type: string }> };
      script: string;
    };
    expect(Object.keys(toolInput).sort()).toEqual(['privateRepo', 'schema', 'script']);
    expect(toolInput.privateRepo).toBe('github/gh-aw-firewall');
    expect(toolInput.schema).toEqual({
      type: 'object',
      fields: {
        package_json: { type: 'boolean' },
        src: { type: 'boolean' },
      },
    });
    expect(toolInput.script).toBe(`import json
import pathlib

root = pathlib.Path("/query/repo")
result = {
    "package_json": (root / "package.json").is_file(),
    "src": (root / "src").is_dir(),
}
pathlib.Path("/query/out").write_text(json.dumps(result), encoding="utf-8")`);
    expect(source).toContain('not as a direct MCP tool');
    expect(source).toContain('Make exactly one enclave call from shell/Bash');
    expect(source).toContain('an invalid invocation consumes that quota too');
    expect(source).toContain('Do not retry a failed\ninvocation');
    expect(source).toContain('AWF enforces isolation and invocation budgets');
    expect(source).not.toMatch(/MCP tool directly|Do not invoke the tool through a shell or CLI|Do not use[^.]*shell commands|inspect its help|probe its schema/);
    expect(source).not.toContain('enclave_run_agent');
    expect(source).toContain('max-invocations: 1');
    expect(source).toContain('invocations.length !== 1');
    expect(source).toContain('record.kind === "invocation"');
    expect(source).toContain('record.kind === "failure"');
    expect(source).toContain('failures.length !== 0');
    expect(source).toContain('invocations[0].sensitivity !== "public"');
    expect(source).toContain('record.type === "report_smoke_result"');
    expect(source).toContain('results[0].result !== expected');
    expect(source).toContain('ENCLAVE_CLOUD_HYPERVISOR_PASS');
  });

  it('uses one non-issue safe-output CLI call for the successful result', () => {
    const commands = [...source.matchAll(/```bash\n([\s\S]*?)\n```/g)]
      .map(match => match[1]).filter(command => command.includes('| safeoutputs '));
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain('| safeoutputs report_smoke_result .');
    const input = JSON.parse(execFileSync('bash', ['-c',
      'function safeoutputs() { [[ "$#" == 2 && "$1" == report_smoke_result && "$2" == . ]] || return 1; cat; }\n' +
      commands[0],
    ], { encoding: 'utf8' }));
    expect(input).toEqual({
      result: 'ENCLAVE_CLOUD_HYPERVISOR_PASS {"package_json":true,"src":true}',
    });
    expect(source).toContain('Do not use safe outputs for discovery, probing, or placeholder calls.');
    expect(source).toContain('do not retry the enclave call or invoke a safe output');
  });

  it('documents the exact official-main guard without relaxing production gates', () => {
    expect(source).toContain('Official repository: `github/gh-aw-firewall`');
    expect(source).toContain('Manual event: `workflow_dispatch`');
    expect(source).toContain('matching\n     `GITHUB_WORKFLOW_SHA` when present');
    expect(source).toContain('at `@refs/heads/main` or `@${GITHUB_SHA}`');
    expect(source).toContain('All pull requests (`refs/pull/*`), non-main branches, forks, and automated events are rejected.');
    expect(source).toContain('unattested developer overrides are rejected.');
    expect(source).toContain('primary and every enclave invocation must use separate VMs');
  });

  it('post-processes the published-release workflow idempotently', () => {
    const patched = applyGeneralWorkflowPatches(lock, workflowPath).content;
    expect(patched).toBe(lock);
    expect(patched).toContain('--container-runtime cloud-hypervisor');
  });

  it('adds the host staging-token exclusion to the primary agent command', () => {
    const compiled = [
      '              "awf-enclave": {',
      '                "type": "http",',
      '                "url": "http://awf-enclave-mcp:8080/mcp"',
      '      - name: Execute GitHub Copilot CLI',
      '        run: sudo --preserve-env awf --config "/trusted/awf-config.json" --env-all --exclude-env MCP_GATEWAY_AGENT_ID',
      '        env:',
      '          GH_TOKEN: ${{ github.token }}',
      '      - name: Upload debug',
      '        name: Upload public enclave debug evidence',
      '        with:',
      '          retention-days: 1',
    ].join('\n');
    const first = applyGeneralWorkflowPatches(compiled, workflowPath).content;
    const second = applyGeneralWorkflowPatches(first, workflowPath).content;

    expect(first).toContain(
      '--exclude-env GH_TOKEN --exclude-env MCP_GATEWAY_API_KEY --exclude-env MCP_GATEWAY_AGENT_ID',
    );
    expect(second).toBe(first);
  });

  it('enables debugging on the real AWF command and collects only after the agent, including failure', () => {
    const compiled = yaml.load(lock) as {
      jobs: Record<string, {
        steps: Array<{ name: string; id?: string; if?: string; run?: string;
          env?: Record<string, string>; uses?: string; with?: Record<string, unknown> }>;
      }>;
    };
    const steps = compiled.jobs.agent.steps;
    const prepare = steps.findIndex(step => step.name === 'Prepare host-only enclave debug collection');
    const execute = steps.findIndex(step => step.name === 'Execute GitHub Copilot CLI');
    const collect = steps.findIndex(step => step.name === 'Collect host-only public enclave debug evidence');
    const upload = steps.findIndex(step => step.name === 'Upload public enclave debug evidence');
    expect(prepare).toBeGreaterThan(-1);
    expect(execute).toBeGreaterThan(prepare);
    expect(collect).toBeGreaterThan(execute);
    expect(upload).toBeGreaterThan(collect);
    expect(steps[execute].run).toContain(
      'sudo --preserve-env awf --cloud-hypervisor-enclave-debug-public --config'
    );
    expect(countOccurrences(steps[execute].run!, '--cloud-hypervisor-enclave-debug-public')).toBe(1);
    expect(steps[execute].env?.DEBUG_RUN_KEY).toBeUndefined();
    expect(steps[prepare].run).toContain('sudo install -m 0600 -o root -g root');
    expect(steps[collect].if).toBe('always()');
    expect(steps[collect].run).toContain('sudo node /var/lib/awf-enclave-smoke-export/collector.cjs collect');
    expect(steps[upload].if).toBe("always() && steps.collect-enclave-debug.outcome == 'success'");
    expect(steps[upload].with?.['retention-days']).toBe(1);
    expect(steps[upload].with?.path).toBe(
      '/var/lib/awf-enclave-smoke-export/${{ github.run_id }}-${{ github.run_attempt }}/upload/'
    );
    expect(steps[upload].with?.['if-no-files-found']).toBe('error');
    expect(source).toContain('intentionally disclosed to Actions artifact readers');
    expect(source.split('---').slice(2).join('---')).not.toContain('/var/lib/');
    expect(() => applyGeneralWorkflowPatches(
      lock.replace('sudo --preserve-env awf --cloud-hypervisor-enclave-debug-public --config', 'missing-awf'),
      workflowPath,
    )).toThrow(/exactly one trusted host AWF/);
    expect(() => applyGeneralWorkflowPatches(
      `${lock}\nsudo --preserve-env awf --cloud-hypervisor-enclave-debug-public --config duplicate`,
      workflowPath,
    )).toThrow(/exactly one trusted host AWF/);
    const uploadBlock = lock.slice(
      lock.indexOf('        name: Upload public enclave debug evidence'),
      lock.indexOf('      - name: Validate enclave invocation and result'),
    );
    expect(() => applyGeneralWorkflowPatches(
      lock.replace(uploadBlock, uploadBlock.replace('          retention-days: 1\n', '')),
      workflowPath,
    )).toThrow(/debug artifact retention/);
  });
});

describe('smoke enclave build workflow', () => {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const lock = fs.readFileSync(lockPath, 'utf8');

  it('uses gh-aw as an internal pseudo-private script enclave', () => {
    expect(source).toContain('repo: github/gh-aw');
    expect(source).toContain('sensitivity: internal');
    expect(source).toContain('memory-limit: 2g');
    expect(source).toContain('tmpfs-limit: 1g');
    expect(lock).toContain('\\"repo\\":\\"github/gh-aw\\",\\"sensitivity\\":\\"internal\\"');
    expect(lock).toContain('\\"memoryLimit\\":\\"2g\\"');
    expect(lock).toContain('\\"tmpfsLimit\\":\\"1g\\"');
    expect(lock).toContain('"tools": ["enclave_run_script"]');
  });

  it('allows Copilot to invoke only the required enclave tool', () => {
    expect(source).toContain('args: ["--allow-tool", "awf-enclave(enclave_run_script)"]');
    const start = lock.indexOf('      - name: Execute GitHub Copilot CLI');
    const end = lock.indexOf('      - name: Detect agent errors');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const executeStep = lock.slice(start, end);
    expect(executeStep).toContain("--allow-tool '\\''awf-enclave(enclave_run_script)'\\''");
    expect(executeStep).not.toContain('--allow-all-tools');
  });

  it('uses the compatible gateway and local AWF build', () => {
    expect(lock).toContain('ghcr.io/github/gh-aw-mcpg:v0.4.30');
    expect(lock).toContain('"awf-enclave": {\n                "required": false,');
    expect(lock).toContain('Install awf binary (local)');
    expect(lock).toContain('--build-local');
  });

  it('post-processes the late-starting enclave backend idempotently', () => {
    const compiled = [
      '              "awf-enclave": {',
      '                "type": "http",',
      '                "url": "http://awf-enclave-mcp:8080/mcp"',
      '      - name: Execute GitHub Copilot CLI',
      '        run: awf --env-all --exclude-env MCP_GATEWAY_AGENT_ID',
      '        env:',
      '          AWF_REFLECT_ENABLED: 1',
    ].join('\n');
    const first = applyGeneralWorkflowPatches(compiled, lockPath).content;
    const second = applyGeneralWorkflowPatches(first, lockPath).content;

    expect(first).toContain('"awf-enclave": {\n                "required": false,');
    expect(first).toContain(
      'MCP_GATEWAY_API_KEY: ${{ steps.start-mcp-gateway.outputs.gateway-api-key }}'
    );
    expect(first).toContain(
      '--exclude-env MCP_GATEWAY_API_KEY --exclude-env MCP_GATEWAY_AGENT_ID'
    );
    expect(second).toBe(first);
  });

  it('keeps the gateway capability out of the primary agent', () => {
    expect(source).toContain('GH_TOKEN: ${{ github.token }}');
    expect(lock).toContain('--exclude-env AWF_ENCLAVE_MCP_CAPABILITY');
    expect(lock).toContain('--exclude-env AWF_ENCLAVE_MCP_GATEWAY_ENDPOINT');
  });

  it('passes gateway authentication to AWF but not the primary agent', () => {
    const executeStep = lock.slice(
      lock.indexOf('      - name: Execute GitHub Copilot CLI'),
      lock.indexOf('      - name: Detect agent errors')
    );

    expect(executeStep).toContain(
      'MCP_GATEWAY_API_KEY: ${{ steps.start-mcp-gateway.outputs.gateway-api-key }}'
    );
    expect(executeStep).toContain('--exclude-env MCP_GATEWAY_API_KEY');
  });

  it('validates the protected enclave audit', () => {
    expect(source).toContain('/tmp/gh-aw/sandbox/firewall/audit/enclave.jsonl');
    expect(source).toContain('ENCLAVE_BUILD_PASS');
    expect(source).toContain('"go_mod":true,"makefile":true');
  });

  it('gives the agent a valid finite-disclosure schema', () => {
    expect(source).toContain("uses AWF's finite-disclosure schema algebra, not JSON");
    expect(source).toContain('"fields": {');
    expect(source).toContain('"type": "enum", "values": ["github.com/github/gh-aw"]');
    expect(source).not.toContain('"properties": {');
    expect(source).not.toContain('"additionalProperties": false');
  });
});

describe('smoke enclave issues workflow', () => {
  const source = fs.readFileSync(issuesSourcePath, 'utf8');
  const lock = fs.readFileSync(issuesLockPath, 'utf8');

  it('allows Copilot to invoke only the required enclave tool', () => {
    expect(source).toContain('args: ["--allow-tool", "awf-enclave(enclave_run_agent)"]');
    const start = lock.indexOf('      - name: Execute GitHub Copilot CLI');
    const end = lock.indexOf('      - name: Detect agent errors');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const executeStep = lock.slice(start, end);
    expect(executeStep).toContain("--allow-tool '\\''awf-enclave(enclave_run_agent)'\\''");
    expect(executeStep).not.toContain('--allow-all-tools');
  });

  it('uses one shared multi-agent MCP gateway', () => {
    expect(countOccurrences(lock, '- name: Start MCP Gateway')).toBe(1);
    expect(lock).not.toContain('Start Enclave GitHub Proxy');
    expect(lock).not.toContain('Stop Enclave GitHub Proxy');
    expect(lock).not.toContain('AWF_ENCLAVE_GITHUB_PROXY_');
    expect(lock).toContain(
      '"agentIds": ["${MCP_GATEWAY_AGENT_ID}","${AWF_ENCLAVE_GITHUB_MCP_AGENT_ID}"]'
    );
    expect(lock).toContain(
      '"${MCP_GATEWAY_AGENT_ID}":{"servers":["awf-enclave","safeoutputs"]'
    );
    expect(lock).toContain('"awf-enclave": {\n                "required": false,');
    expect(lock).toContain('"GITHUB_TOOLSETS": "issues"');
    expect(lock).toContain(
      '"github": {\n                "required": false,\n                "type": "stdio"'
    );
  });

  it('denies the primary agent every direct GitHub data path', () => {
    expect(source).toContain('network:\n  allowed: []');
    expect(source).not.toContain('GH_TOKEN: ${{ github.token }}');
    expect(source).toContain('tools:\n  github: false');
    expect(lock).toContain(
      '\\"network\\":{\\"isolation\\":true,\\"topologyAttach\\":[\\"awmg-mcpg\\"]}'
    );
    expect(lock).not.toContain('\\"allowDomains\\":');
    expect(lock).not.toContain(
      '"${MCP_GATEWAY_AGENT_ID}":{"servers":["awf-enclave","github","safeoutputs"]'
    );

    const executeStep = lock.slice(
      lock.indexOf('      - name: Execute GitHub Copilot CLI'),
      lock.indexOf('      - name: Detect agent errors')
    );
    expect(executeStep).not.toContain('GITHUB_MCP_SERVER_TOKEN:');
    expect(executeStep).toContain(
      'GH_TOKEN: ${{ secrets.GH_AW_GITHUB_MCP_SERVER_TOKEN || secrets.GH_AW_GITHUB_TOKEN || secrets.GITHUB_TOKEN }}'
    );
    expect(executeStep).toContain('--exclude-env GH_TOKEN');
    expect(executeStep).toContain('--exclude-env AWF_ENCLAVE_GITHUB_MCP_AGENT_ID');
  });

  it('restricts the enclave identity to the declared GitHub read surface', () => {
    expect(lock).toContain(
      '"${AWF_ENCLAVE_GITHUB_MCP_AGENT_ID}":{"servers":["github"],' +
        '"tools":{"github":["list_issues","issue_read"]},' +
        '"allow-only":{"min-integrity":"approved","repos":["github/gh-aw"]}}'
    );
    expect(lock).toContain(
      '"min-integrity": "approved",\n                    "repos": [\n                      "github/gh-aw"\n                    ]'
    );
    expect(source).toContain('Use only the `github` MCP server');
    expect(source).toContain('GitHub CLI, GraphQL, search, writes, or any other GitHub tool');
    expect(source).toContain('the discovered issue number');
    expect(source).not.toContain('issue_number: 50920');
  });

  it('keeps the enclave identity out of the primary agent', () => {
    expect(lock).toContain(
      'AWF_ENCLAVE_GITHUB_MCP_AGENT_ID=$(openssl rand -base64 45'
    );
    expect(lock).toContain('echo "::add-mask::${AWF_ENCLAVE_GITHUB_MCP_AGENT_ID}"');
    expect(lock).toContain('--exclude-env AWF_ENCLAVE_GITHUB_MCP_AGENT_ID');
    expect(lock).toContain('--exclude-env MCP_GATEWAY_AGENT_ID');
    expect(lock).toContain(
      'MCP_GATEWAY_API_KEY: ${{ steps.start-mcp-gateway.outputs.gateway-api-key }}'
    );
    expect(lock).toContain('--exclude-env MCP_GATEWAY_API_KEY');
  });

  it('tests the local AWF implementation with mcpg v0.4.15', () => {
    expect(lock).toContain('ghcr.io/github/gh-aw-mcpg:v0.4.15');
    expect(lock).toContain('Install awf binary (local)');
    expect(lock).toContain('--build-local');
    expect(lock).not.toMatch(
      /download_docker_images\.sh[^\n]*ghcr\.io\/github\/gh-aw-firewall\/enclave-(?:agent|mcp-server)/
    );
  });

  it('bounds the single enclave disclosure', () => {
    expect(source).toContain('max-invocations: 1');
    expect(source).toContain('max-output-bytes: 1024');
    expect(source).toContain('"issue_number": { "type": "integer"');
    expect(source).toContain('ENCLAVE_ISSUES_READ_PASS');
  });
});

describe('smoke enclave dynamic issues workflow', () => {
  const source = fs.readFileSync(dynamicSourcePath, 'utf8');
  const lock = fs.readFileSync(dynamicLockPath, 'utf8');

  it('allows Copilot to invoke only the required enclave tool', () => {
    expect(source).toContain('args: ["--allow-tool", "awf-enclave(enclave_run_agent)"]');
    const start = lock.indexOf('      - name: Execute GitHub Copilot CLI');
    const end = lock.indexOf('      - name: Detect agent errors');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const executeStep = lock.slice(start, end);
    expect(executeStep).toContain("--allow-tool '\\''awf-enclave(enclave_run_agent)'\\''");
    expect(executeStep).not.toContain('--allow-all-tools');
  });

  it('declares dynamic repository delegation without static repos', () => {
    expect(source).toContain('dynamic:\n      allowed-owners: [github]');
    expect(source).toContain('github-policy: github-repository-read-v1');
    expect(source).toContain('sensitivity: internal');
    expect(source).not.toContain('repos:\n      - repo:');
    expect(lock).toContain('\\"dynamic\\":{\\"allowedOwners\\":[\\"github\\"]');
    expect(lock).toContain('\\"version\\":\\"github-repository-read-v1\\"');
    expect(lock).not.toContain('\\"repos\\":[{\\"repo\\":\\"github/gh-aw\\"');
  });

  it('uses mcpg v0.4.19 with the delegation controller', () => {
    expect(lock).toContain('ghcr.io/github/gh-aw-mcpg:v0.4.19');
    expect(lock).toContain('AWF_ENCLAVE_GITHUB_DELEGATION_CONTROL_CAPABILITY=$(openssl rand -hex 32');
    expect(lock).toContain('AWF_ENCLAVE_GITHUB_DELEGATION_CONTROL_ENDPOINT="http://127.0.0.1:8090/internal/awf-enclave-mcp-control/github-repository-delegation-v1"');
    expect(lock).toContain(
      `-p 127.0.0.1:'"\${MCP_GATEWAY_DELEGATION_CONTROL_LISTEN#*:}"':'"\${MCP_GATEWAY_DELEGATION_CONTROL_LISTEN#*:}"'`
    );
    expect(lock).toContain('Install awf binary (local)');
    expect(lock).toContain('--build-local');
  });

  it('keeps the delegation envelope live for the job while bounding identity TTL', () => {
    expect(lock).toContain(
      'GH_AW_ENCLAVE_DYNAMIC_JOB_EXPIRES_EPOCH=$(( $(date -u +%s) + (${GH_AW_TIMEOUT_MINUTES:-20} * 60) ))'
    );
    expect(lock).toContain('\\"max_identity_ttl\\":180');
  });

  it('excludes control capability and gateway keys from primary agent', () => {
    const executeStep = lock.slice(
      lock.indexOf('      - name: Execute GitHub Copilot CLI'),
      lock.indexOf('      - name: Detect agent errors')
    );
    expect(executeStep).toContain('--exclude-env AWF_ENCLAVE_GITHUB_DELEGATION_CONTROL_CAPABILITY');
    expect(executeStep).toContain('--exclude-env AWF_ENCLAVE_MCP_CAPABILITY');
    expect(executeStep).not.toContain('GH_TOKEN');
    expect(executeStep).toContain('--exclude-env MCP_GATEWAY_API_KEY');
  });

  it('post-processes the dynamic enclave backend idempotently', () => {
    const first = applyGeneralWorkflowPatches(lock, dynamicLockPath).content;
    const second = applyGeneralWorkflowPatches(first, dynamicLockPath).content;
    expect(first).toContain('"awf-enclave": {\n                "required": false,');
    expect(second).toBe(first);
  });

  it('validates dynamic read-only enclave audit and execution pass', () => {
    expect(source).toContain('ENCLAVE_DYNAMIC_ISSUES_READ_PASS');
    expect(source).toContain('"list_read": { "type": "boolean" }');
    expect(source).toContain('"issue_read": { "type": "boolean" }');
    expect(lock).toContain('ENCLAVE_DYNAMIC_ISSUES_READ_PASS');
  });
});
