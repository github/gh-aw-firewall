import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { spawn } from 'child_process';
import { once } from 'events';
import { join } from 'path';

const wrapper = join(process.cwd(), 'containers/agent/gh-cli-proxy-wrapper.sh');

interface ProxyRequest {
  args: string[];
  stdin: string;
}

function run(command: string, args: string[], input: string, env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (exitCode) => resolve({ stdout, stderr, exitCode }));
    child.stdin.end(input);
  });
}

describe('gh CLI proxy wrapper', () => {
  let server: Server;
  let requests: ProxyRequest[];
  let proxyUrl: string;

  beforeEach(async () => {
    requests = [];
    server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()) as ProxyRequest;
      requests.push(body);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ stdout: 'line1\nline2\n', stderr: '', exitCode: 0 }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected TCP server address');
    proxyUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    server.close();
    await once(server, 'close');
  });

  it('preserves multiline, empty, and double-dash arguments and output newlines', async () => {
    const result = await run(
      'sh',
      [wrapper, 'api', 'graphql', '-f', 'query=query {\n  viewer { login }\n}', '', '--'],
      '',
      { ...process.env, AWF_CLI_PROXY_URL: proxyUrl },
    );

    expect(result).toEqual({ stdout: 'line1\nline2\n', stderr: '', exitCode: 0 });
    expect(requests.map(({ args, stdin }) => ({ args, stdin }))).toEqual([{
      args: ['api', 'graphql', '-f', 'query=query {\n  viewer { login }\n}', '', '--'],
      stdin: '',
    }]);
  });

  it('does not consume redirected stdin unless gh is given an explicit stdin argument', async () => {
    const result = await run(
      'sh',
      ['-c', 'while read -r n; do sh "$1" api "x/$n"; done', 'sh', wrapper],
      '1\n2\n3\n',
      { ...process.env, AWF_CLI_PROXY_URL: proxyUrl },
    );

    expect(result.exitCode).toBe(0);
    expect(requests.map(({ args, stdin }) => ({ args, stdin }))).toEqual([
      { args: ['api', 'x/1'], stdin: '' },
      { args: ['api', 'x/2'], stdin: '' },
      { args: ['api', 'x/3'], stdin: '' },
    ]);
  });

  it('forwards stdin when gh is explicitly given an input marker', async () => {
    const result = await run(
      'sh',
      [wrapper, 'api', '--input', '-'],
      'payload\n',
      { ...process.env, AWF_CLI_PROXY_URL: proxyUrl },
    );

    expect(result.exitCode).toBe(0);
    expect(requests.map(({ args, stdin }) => ({ args, stdin }))).toEqual([
      { args: ['api', '--input', '-'], stdin: 'cGF5bG9hZAo=' },
    ]);
  });
});
