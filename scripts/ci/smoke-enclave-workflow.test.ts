import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const sourcePath = path.join(workflowsDir, 'smoke-enclave-build-test.md');
const lockPath = path.join(workflowsDir, 'smoke-enclave-build-test.lock.yml');

describe('smoke enclave build workflow', () => {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const lock = fs.readFileSync(lockPath, 'utf8');

  it('uses gh-aw as an internal pseudo-private script enclave', () => {
    expect(source).toContain('repo: github/gh-aw');
    expect(source).toContain('sensitivity: internal');
    expect(lock).toContain('\\"repo\\":\\"github/gh-aw\\",\\"sensitivity\\":\\"internal\\"');
    expect(lock).toContain('"tools": ["enclave_run_script"]');
  });

  it('uses the compatible gateway and local AWF build', () => {
    expect(lock).toContain('ghcr.io/github/gh-aw-mcpg:v0.4.9');
    expect(lock).toContain('Install awf binary (local)');
    expect(lock).toContain('--build-local');
  });

  it('keeps the gateway capability out of the primary agent', () => {
    expect(source).toContain('GH_TOKEN: ${{ github.token }}');
    expect(lock).toContain('--exclude-env AWF_ENCLAVE_MCP_CAPABILITY');
    expect(lock).toContain('--exclude-env AWF_ENCLAVE_MCP_GATEWAY_ENDPOINT');
  });

  it('validates the protected enclave audit', () => {
    expect(source).toContain('/tmp/gh-aw/sandbox/firewall/audit/enclave.jsonl');
    expect(source).toContain('ENCLAVE_BUILD_PASS');
    expect(source).toContain('"go_mod":true,"makefile":true');
  });
});
