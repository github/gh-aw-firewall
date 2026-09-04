import * as fs from 'fs';
import * as path from 'path';
import { applyGeneralWorkflowPatches } from './apply-general-workflow-patches';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const sourcePath = path.join(workflowsDir, 'smoke-enclave-build-test.md');
const lockPath = path.join(workflowsDir, 'smoke-enclave-build-test.lock.yml');
const issuesSourcePath = path.join(workflowsDir, 'smoke-enclave-issues-read.md');
const issuesLockPath = path.join(workflowsDir, 'smoke-enclave-issues-read.lock.yml');

function countOccurrences(content: string, value: string): number {
  return content.split(value).length - 1;
}

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

  it('uses the compatible gateway and local AWF build', () => {
    expect(lock).toContain('ghcr.io/github/gh-aw-mcpg:v0.4.15');
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
      'export GH_AW_MCP_DEFERRED_SERVERS="awf-enclave,github"'
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
    expect(executeStep).toContain('--exclude-env AWF_ENCLAVE_GITHUB_MCP_AGENT_ID');
  });

  it('restricts the enclave identity to the declared GitHub read surface', () => {
    expect(lock).toContain(
      '"${AWF_ENCLAVE_GITHUB_MCP_AGENT_ID}":{"servers":["github"],' +
        '"tools":{"github":["list_issues","issue_read"]},' +
        '"allow-only":{"min-integrity":"approved","repos":["github/gh-aw"]}}'
    );
    expect(lock).toContain(
      '"min-integrity": "approved",\n                    "repos": ["github/gh-aw"]'
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
