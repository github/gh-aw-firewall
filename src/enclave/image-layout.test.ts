import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The unified enclave MCP server image reuses two audited source trees rather
 * than duplicating them. These tests pin that contract: the Dockerfile must
 * copy both trees into the layout the server's `require` specifiers assume, and
 * the release pipeline must publish every image the server references.
 */

const repoRoot = path.join(__dirname, '..', '..');
const containersRoot = path.join(repoRoot, 'containers');
const dockerfilePath = path.join(containersRoot, 'bounded-query', 'enclave-mcp', 'Dockerfile');

function readDockerfile(): string {
  return fs.readFileSync(dockerfilePath, 'utf8');
}

describe('enclave MCP server image contract', () => {
  it('copies both executor source trees plus the shared foundation', () => {
    const dockerfile = readDockerfile();
    for (const copy of [
      'COPY bounded-query/bounded-execution/ /opt/awf/bounded-execution/',
      'COPY bounded-query/broker/ /opt/awf/broker/',
      'COPY bounded-agent/broker/ /opt/awf/agent-broker/',
      'COPY bounded-query/enclave-mcp/ /opt/awf/enclave-mcp/',
      'COPY bounded-query/query-seccomp.json /opt/awf/enclave-seccomp.json',
    ]) {
      expect(dockerfile).toContain(copy);
    }
    expect(dockerfile).toContain('AS enclave-mcp-server');
    expect(dockerfile).toContain('ENTRYPOINT ["node", "/opt/awf/enclave-mcp/server.js"]');
  });

  it('no longer ships the server stage from the bounded-query image', () => {
    const boundedQuery = fs.readFileSync(
      path.join(containersRoot, 'bounded-query', 'Dockerfile'),
      'utf8',
    );
    expect(boundedQuery).not.toContain('AS enclave-mcp-server');
    expect(boundedQuery).toContain('FROM python:3.12-alpine3.21 AS query');
    expect(boundedQuery).toContain('AS broker');
  });

  it('resolves the whole server module graph from the published layout', () => {
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-enclave-image-'));
    const awf = path.join(stage, 'opt', 'awf');
    try {
      fs.mkdirSync(awf, { recursive: true });
      fs.cpSync(
        path.join(containersRoot, 'bounded-query', 'bounded-execution'),
        path.join(awf, 'bounded-execution'),
        { recursive: true },
      );
      fs.cpSync(
        path.join(containersRoot, 'bounded-query', 'broker'),
        path.join(awf, 'broker'),
        { recursive: true },
      );
      fs.cpSync(
        path.join(containersRoot, 'bounded-agent', 'broker'),
        path.join(awf, 'agent-broker'),
        { recursive: true },
      );
      fs.cpSync(
        path.join(containersRoot, 'bounded-query', 'enclave-mcp'),
        path.join(awf, 'enclave-mcp'),
        { recursive: true },
      );
      fs.rmSync(path.join(awf, 'enclave-mcp', 'Dockerfile'), { force: true });

      for (const relative of [
        'enclave-mcp/server.js',
        'enclave-mcp/agent-executor.js',
        'enclave-mcp/config.js',
        'enclave-mcp/mcp-protocol.js',
        'agent-broker/enclave-runner.js',
        'agent-broker/workspace.js',
        'agent-broker/framing.js',
        'broker/broker.js',
        'broker/query-runner.js',
      ]) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        expect(require(path.join(awf, relative))).toBeDefined();
      }
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  });

  it('publishes the enclave-agent image and the wider-context server build', () => {
    const release = fs.readFileSync(
      path.join(repoRoot, '.github', 'workflows', 'release.yml'),
      'utf8',
    );
    expect(release).toContain('file: ./containers/bounded-query/enclave-mcp/Dockerfile');
    expect(release).toMatch(/enclave-agent:\$\{\{ needs\.bump-version\.outputs\.version_number \}\}/);
    expect(release).toContain('enclave_agent_digest');
    expect(release).toContain('id: build_enclave_agent');
  });
});
