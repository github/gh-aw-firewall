import * as fs from 'fs';
import * as path from 'path';
import { applyGeneralWorkflowPatches } from './apply-general-workflow-patches';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const sourcePath = path.join(workflowsDir, 'smoke-enclave-build-test.md');
const lockPath = path.join(workflowsDir, 'smoke-enclave-build-test.lock.yml');

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
    expect(lock).toContain('ghcr.io/github/gh-aw-mcpg:v0.4.12');
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
      '        env:',
      '          AWF_REFLECT_ENABLED: 1',
    ].join('\n');
    const first = applyGeneralWorkflowPatches(compiled, lockPath).content;
    const second = applyGeneralWorkflowPatches(first, lockPath).content;

    expect(first).toContain('"awf-enclave": {\n                "required": false,');
    expect(first).toContain(
      'MCP_GATEWAY_API_KEY: ${{ steps.start-mcp-gateway.outputs.gateway-api-key }}'
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
