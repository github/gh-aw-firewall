import { spawnSync } from 'child_process';
import { assertSbxApiProxyReflect } from './sbx-manager';
import { mockExecaFn } from './test-helpers/mock-execa.test-utils';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());

describe('assertSbxApiProxyReflect', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('installs a resolver alias and probes the reflection endpoint with Node fetch', async () => {
    mockExecaFn.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    const environment: Record<string, string> = { NO_PROXY: 'api-proxy' };

    await expect(assertSbxApiProxyReflect(
      'awf-agent-test',
      environment,
      '/workspace',
    )).resolves.toBeUndefined();

    const args: string[] = mockExecaFn.mock.calls[0][1];
    const command = args[args.length - 1];
    expect(environment.HOSTALIASES).toBe('/tmp/awf-hostaliases');
    expect(command).toContain(
      'printf "api-proxy localhost\\n" > "$HOSTALIASES"',
    );
    expect(command).toContain('base64 --decode > /tmp/awf-reflect-bridge.cjs');
    expect(command).toContain('nohup node /tmp/awf-reflect-bridge.cjs');
    const encodedBridge = command.match(/printf %s ([A-Za-z0-9+/=]+) \| base64/)?.[1];
    expect(encodedBridge).toBeDefined();
    const bridgeSource = Buffer.from(encodedBridge!, 'base64').toString('utf8');
    expect(bridgeSource).toContain('host: `${upstreamHost}:10000`');
    expect(() => new Function('require', bridgeSource)).not.toThrow();
    expect(command).toContain('http://api-proxy:10000/reflect');
    expect(command).toContain('node -e');
    expect(command).toContain('console.error(error, error.cause)');
    expect(command).toContain('AbortSignal.timeout(500)');
    expect(command).toContain('cat /tmp/awf-reflect-bridge.log');
    expect(command).toContain('for attempt in $(seq 1 30)');
    expect(command).toContain('exit 1; }');
    expect(command).not.toContain('/etc/hosts');
    expect(spawnSync('bash', ['-n', '-c', command]).status).toBe(0);
  });

  it('fails closed when the reflection endpoint is unreachable', async () => {
    mockExecaFn.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' });

    await expect(assertSbxApiProxyReflect(
      'awf-agent-test',
      {},
    )).rejects.toThrow('cannot reach the API proxy /reflect endpoint');
  });
});
