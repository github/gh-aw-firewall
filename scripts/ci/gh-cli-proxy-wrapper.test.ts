import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { spawn } from 'child_process';
import { once } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { baseConfig, mockNetworkConfig } from '../../src/test-helpers/docker-test-fixtures.test-utils';
import { buildProxyEnvironment } from '../../src/services/agent-environment/proxy-environment';
const wrapper = 'containers/agent/gh-cli-proxy-wrapper.sh';

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
  let responseBody: { stdout: string; stderr: string; exitCode: number };

  beforeEach(async () => {
    requests = [];
    responseBody = { stdout: 'line1\nline2\n', stderr: '', exitCode: 0 };
    server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()) as ProxyRequest;
      requests.push(body);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(responseBody));
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

  it('routes CLI proxy requests directly when lowercase http_proxy is configured', async () => {
    let parentProxyRequests = 0;
    let sidecarRequests = 0;
    const parentProxy = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        parentProxyRequests++;
        response.statusCode = 502;
        response.end();
      });
    });
    const sidecar = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        sidecarRequests++;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(responseBody));
      });
    });

    parentProxy.listen(0, '127.0.0.1');
    sidecar.listen(0, '127.0.0.1');
    await Promise.all([once(parentProxy, 'listening'), once(sidecar, 'listening')]);
    const curlHome = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-curl-'));

    try {
      const parentProxyAddress = parentProxy.address();
      const sidecarAddress = sidecar.address();
      if (parentProxyAddress === null || typeof parentProxyAddress === 'string' ||
          sidecarAddress === null || typeof sidecarAddress === 'string') {
        throw new Error('Expected TCP server addresses');
      }

      const sidecarIp = '172.30.0.50';
      // Map the sidecar address to the local test server for direct requests.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      fs.writeFileSync(
        path.join(curlHome, '.curlrc'),
        `resolve = "${sidecarIp}:${sidecarAddress.port}:127.0.0.1"\n`,
      );
      const proxyEnvironment: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: curlHome,
        AWF_CLI_PROXY_URL: `http://${sidecarIp}:${sidecarAddress.port}`,
        HTTP_PROXY: `http://127.0.0.1:${parentProxyAddress.port}`,
        http_proxy: `http://127.0.0.1:${parentProxyAddress.port}`,
      };
      delete proxyEnvironment.NO_PROXY;
      delete proxyEnvironment.no_proxy;
      delete proxyEnvironment.ALL_PROXY;
      delete proxyEnvironment.all_proxy;

      const withoutBypass = await run('sh', [wrapper, 'api', 'status'], '', proxyEnvironment);
      expect(withoutBypass.exitCode).toBe(1);
      expect(parentProxyRequests).toBe(1);
      expect(sidecarRequests).toBe(0);

      const environment: Record<string, string> = {};
      buildProxyEnvironment({
        config: { ...baseConfig, workDir: '/tmp/awf-work', difcProxyHost: 'host.docker.internal:18443' },
        networkConfig: { ...mockNetworkConfig, cliProxyIp: sidecarIp },
        environment,
      });
      proxyEnvironment.NO_PROXY = environment.NO_PROXY;
      proxyEnvironment.no_proxy = environment.no_proxy;

      const withBypass = await run('sh', [wrapper, 'api', 'status'], '', proxyEnvironment);
      expect(withBypass).toEqual({ stdout: 'line1\nline2\n', stderr: '', exitCode: 0 });
      expect(parentProxyRequests).toBe(1);
      expect(sidecarRequests).toBe(1);
    } finally {
      parentProxy.close();
      sidecar.close();
      await Promise.all([once(parentProxy, 'close'), once(sidecar, 'close')]);
      fs.rmSync(curlHome, { recursive: true, force: true });
    }
  });

  it('fails safely for an invalid proxy exit code', async () => {
    responseBody.exitCode = 256;

    const result = await run(
      'sh',
      [wrapper, 'api', 'x'],
      '',
      { ...process.env, AWF_CLI_PROXY_URL: proxyUrl },
    );

    expect(result.exitCode).toBe(1);
  });
});
