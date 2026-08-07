import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const repoRoot = path.join(__dirname, '..', '..');
const containersRoot = path.join(repoRoot, 'containers');
const dockerfilePath = path.join(containersRoot, 'enclave', 'Dockerfile');

describe('enclave image contract', () => {
  it('builds all three enclave images from one neutral Dockerfile', () => {
    const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');
    for (const target of ['AS enclave-script', 'AS enclave-agent', 'AS enclave-mcp-server']) {
      expect(dockerfile).toContain(target);
    }
    for (const copy of [
      'COPY bounded-execution/ /opt/awf/bounded-execution/',
      'COPY enclave/script-executor/ /opt/awf/enclave/script-executor/',
      'COPY enclave/agent-executor/ /opt/awf/enclave/agent-executor/',
      'COPY enclave/mcp-server/ /opt/awf/enclave/mcp-server/',
      'COPY enclave/seccomp.json /opt/awf/enclave-seccomp.json',
    ]) {
      expect(dockerfile).toContain(copy);
    }
  });

  it('resolves the complete server module graph from the image layout', () => {
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-enclave-image-'));
    const awf = path.join(stage, 'opt', 'awf');
    try {
      fs.mkdirSync(awf, { recursive: true });
      for (const [source, destination] of [
        ['bounded-execution', 'bounded-execution'],
        ['enclave/script-executor', 'enclave/script-executor'],
        ['enclave/agent-executor', 'enclave/agent-executor'],
        ['enclave/mcp-server', 'enclave/mcp-server'],
      ]) {
        fs.cpSync(path.join(containersRoot, source), path.join(awf, destination), { recursive: true });
      }
      for (const relative of [
        'enclave/mcp-server/server.js',
        'enclave/mcp-server/agent-executor.js',
        'enclave/mcp-server/config.js',
        'enclave/mcp-server/mcp-protocol.js',
        'enclave/agent-executor/enclave-runner.js',
        'enclave/agent-executor/workspace.js',
        'enclave/agent-executor/framing.js',
        'enclave/script-executor/executor-handler.js',
        'enclave/script-executor/script-runner.js',
      ]) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        expect(require(path.join(awf, relative))).toBeDefined();
      }
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  });

  it('publishes only the unified enclave images', () => {
    const release = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');
    expect(release).toContain('file: ./containers/enclave/Dockerfile');
    for (const image of ['enclave-script', 'enclave-agent', 'enclave-mcp-server']) {
      expect(release).toContain(image);
    }
  });
});
