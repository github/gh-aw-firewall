import { buildAppleContainerRunArgs, type AppleContainerRunSpec } from './run-args';
import {
  APPLE_CONTAINER_TRANSPORT_CAPABILITIES,
  APPLE_CONTAINER_TRANSPORT_CONTRACT_VERSION,
  APPLE_CONTAINER_TRANSPORT_GUEST_DIRECTORY,
} from './transport-capabilities';
import {
  APPLE_CONTAINER_REQUIRED_CAP_DROPS,
  applyAppleContainerTransportToRunSpec,
  planAppleContainerTransport,
  type AppleContainerTransportPlan,
} from './transport-plan';
import type { AppleContainerSocketDirectoryHandle } from './transport-socket-dir';

const DIRECTORY: AppleContainerSocketDirectoryHandle = {
  path: '/tmp/awf-apple-abc123def456',
  runId: 'abc123def456',
};

const INIT_IMAGE = 'ghcr.io/github/gh-aw-firewall/apple-init:v1';

function plan(
  capabilities = [
    { id: 'squid', upstream: { host: '127.0.0.1', port: 3128 } },
    { id: 'api-proxy-anthropic', upstream: { host: '127.0.0.1', port: 10001 } },
  ],
): AppleContainerTransportPlan {
  return planAppleContainerTransport({
    directory: DIRECTORY,
    capabilities,
    initImage: INIT_IMAGE,
  });
}

describe('planAppleContainerTransport', () => {
  it('produces one publish-socket pair per capability', () => {
    const result = plan();
    expect(result.socketMounts).toEqual([
      {
        hostPath: '/tmp/awf-apple-abc123def456/squid.sock',
        containerPath: `${APPLE_CONTAINER_TRANSPORT_GUEST_DIRECTORY}/squid.sock`,
      },
      {
        hostPath: '/tmp/awf-apple-abc123def456/api-proxy-anthropic.sock',
        containerPath: `${APPLE_CONTAINER_TRANSPORT_GUEST_DIRECTORY}/api-proxy-anthropic.sock`,
      },
    ]);
    expect(result.contractVersion).toBe(APPLE_CONTAINER_TRANSPORT_CONTRACT_VERSION);
  });

  it('points every proxy variable at the guest-side Squid endpoint', () => {
    const result = plan();
    expect(result.env.HTTP_PROXY).toBe('http://127.0.0.1:3128');
    expect(result.env.HTTPS_PROXY).toBe('http://127.0.0.1:3128');
    expect(result.env.http_proxy).toBe('http://127.0.0.1:3128');
    expect(result.env.https_proxy).toBe('http://127.0.0.1:3128');
    expect(result.env.SQUID_PROXY_HOST).toBe('127.0.0.1');
    expect(result.env.SQUID_PROXY_PORT).toBe('3128');
  });

  it('exempts loopback from the proxy so relayed endpoints are reachable', () => {
    const result = plan();
    expect(result.env.NO_PROXY).toContain('127.0.0.1');
    expect(result.env.no_proxy).toBe(result.env.NO_PROXY);
  });

  it('publishes an endpoint variable for each capability and nothing more', () => {
    const result = plan();
    expect(result.env.AWF_APPLE_TRANSPORT_SQUID_URL).toBe('http://127.0.0.1:3128');
    expect(result.env.AWF_APPLE_TRANSPORT_API_PROXY_ANTHROPIC_URL)
      .toBe('http://127.0.0.1:10001');
    expect(result.env.AWF_APPLE_TRANSPORT_CLI_PROXY_URL).toBeUndefined();
  });

  it('never places a credential in the guest environment', () => {
    const result = planAppleContainerTransport({
      directory: DIRECTORY,
      capabilities: APPLE_CONTAINER_TRANSPORT_CAPABILITIES.map((capability) => ({
        id: capability.id,
        upstream: { host: '127.0.0.1', port: capability.guestPort },
      })),
      initImage: INIT_IMAGE,
    });
    const serialized = JSON.stringify(result).toLowerCase();
    for (const secretish of ['api_key', 'apikey', 'token', 'secret', 'authorization', 'bearer']) {
      expect(serialized).not.toContain(secretish);
    }
  });

  it('drops the mandatory capabilities', () => {
    expect(plan().capDrop).toEqual(APPLE_CONTAINER_REQUIRED_CAP_DROPS);
    expect(plan().capDrop).toEqual(expect.arrayContaining(['NET_RAW', 'NET_ADMIN', 'SYS_ADMIN']));
  });

  it('defaults the guest rootfs to read-only but honours an explicit choice', () => {
    expect(plan().readOnlyRootfs).toBe(true);
    const writable = planAppleContainerTransport({
      directory: DIRECTORY,
      capabilities: [{ id: 'squid', upstream: { host: '127.0.0.1', port: 3128 } }],
      initImage: INIT_IMAGE,
      readOnlyRootfs: false,
    });
    expect(writable.readOnlyRootfs).toBe(false);
  });

  it('requires the squid capability', () => {
    expect(() => planAppleContainerTransport({
      directory: DIRECTORY,
      capabilities: [{ id: 'cli-proxy', upstream: { host: '127.0.0.1', port: 11000 } }],
      initImage: INIT_IMAGE,
    })).toThrow(/must include the "squid" capability/);
  });

  it('rejects an empty capability set', () => {
    expect(() => planAppleContainerTransport({
      directory: DIRECTORY,
      capabilities: [],
      initImage: INIT_IMAGE,
    })).toThrow(/at least one capability/);
  });

  it('rejects duplicates and unknown capabilities', () => {
    expect(() => plan([
      { id: 'squid', upstream: { host: '127.0.0.1', port: 3128 } },
      { id: 'squid', upstream: { host: '127.0.0.1', port: 3129 } },
    ])).toThrow(/is duplicated/);
    expect(() => plan([
      { id: 'squid', upstream: { host: '127.0.0.1', port: 3128 } },
      { id: 'host-network', upstream: { host: '127.0.0.1', port: 1 } },
    ])).toThrow(/not in the allowlist/);
  });

  it('rejects an upstream outside the AWF-owned address space', () => {
    expect(() => plan([
      { id: 'squid', upstream: { host: '169.254.169.254', port: 80 } },
    ])).toThrow(/not a loopback or private address/);
  });

  it('rejects an init image reference that could split argv', () => {
    expect(() => planAppleContainerTransport({
      directory: DIRECTORY,
      capabilities: [{ id: 'squid', upstream: { host: '127.0.0.1', port: 3128 } }],
      initImage: '--privileged',
    })).toThrow(/image reference/);
  });
});

describe('applyAppleContainerTransportToRunSpec', () => {
  const baseSpec: AppleContainerRunSpec = { image: 'ghcr.io/github/gh-aw-firewall/agent:latest' };

  it('keeps the guest on no network', () => {
    const merged = applyAppleContainerTransportToRunSpec(baseSpec, plan());
    expect(merged.network).toEqual({ kind: 'none' });
    expect(buildAppleContainerRunArgs(merged)).toContain('none');
  });

  it('always emits --network none in the argv', () => {
    const argv = buildAppleContainerRunArgs(
      applyAppleContainerTransportToRunSpec(baseSpec, plan()),
    );
    const index = argv.indexOf('--network');
    expect(index).toBeGreaterThan(-1);
    expect(argv[index + 1]).toBe('none');
    expect(argv.filter((token) => token === '--network')).toHaveLength(1);
  });

  it('refuses a run spec that attaches a network', () => {
    expect(() => applyAppleContainerTransportToRunSpec(
      { ...baseSpec, network: { kind: 'attach', networks: ['bridge'] } },
      plan(),
    )).toThrow(/cannot be combined with the capability transport/);
  });

  it('refuses forbidden capability additions in any spelling', () => {
    for (const capability of ['ALL', 'all', 'CAP_NET_ADMIN', 'net_raw', 'SYS_ADMIN']) {
      expect(() => applyAppleContainerTransportToRunSpec(
        { ...baseSpec, capAdd: [capability] },
        plan(),
      )).toThrow(/refuses capAdd/);
    }
  });

  it('permits a benign capability addition', () => {
    const merged = applyAppleContainerTransportToRunSpec(
      { ...baseSpec, capAdd: ['CHOWN'] },
      plan(),
    );
    expect(merged.capAdd).toEqual(['CHOWN']);
  });

  it('unions cap drops without duplicating an existing one', () => {
    const merged = applyAppleContainerTransportToRunSpec(
      { ...baseSpec, capDrop: ['CAP_NET_RAW', 'MKNOD'] },
      plan(),
    );
    expect(merged.capDrop).toEqual([
      'CAP_NET_RAW',
      'MKNOD',
      'NET_ADMIN',
      'SYS_ADMIN',
      'SYS_MODULE',
      'SYS_RAWIO',
    ]);
  });

  it('emits every publish-socket token in the argv', () => {
    const argv = buildAppleContainerRunArgs(
      applyAppleContainerTransportToRunSpec(baseSpec, plan()),
    );
    expect(argv).toContain(
      `/tmp/awf-apple-abc123def456/squid.sock:${APPLE_CONTAINER_TRANSPORT_GUEST_DIRECTORY}/squid.sock`,
    );
    expect(argv.filter((token) => token === '--publish-socket')).toHaveLength(2);
  });

  it('pins the init image and refuses a conflicting one', () => {
    expect(applyAppleContainerTransportToRunSpec(baseSpec, plan()).initImage).toBe(INIT_IMAGE);
    expect(() => applyAppleContainerTransportToRunSpec(
      { ...baseSpec, initImage: 'ghcr.io/other/init:latest' },
      plan(),
    )).toThrow(/requires init image/);
  });

  it('refuses a conflicting transport environment variable', () => {
    expect(() => applyAppleContainerTransportToRunSpec(
      { ...baseSpec, env: { HTTPS_PROXY: 'http://evil.example:8080' } },
      plan(),
    )).toThrow(/already set to a different value/);
  });

  it('accepts an identical environment variable', () => {
    const merged = applyAppleContainerTransportToRunSpec(
      { ...baseSpec, env: { HTTPS_PROXY: 'http://127.0.0.1:3128', EXTRA: 'ok' } },
      plan(),
    );
    expect(merged.env?.EXTRA).toBe('ok');
    expect(merged.env?.HTTPS_PROXY).toBe('http://127.0.0.1:3128');
  });

  it('refuses to publish any socket the plan did not authorise', () => {
    // The headline case: a Docker socket published into the guest would be a
    // direct escape to host root that every other guarantee here survives.
    expect(() => applyAppleContainerTransportToRunSpec(
      {
        ...baseSpec,
        socketMounts: [{
          hostPath: '/var/run/docker.sock',
          containerPath: '/var/run/docker.sock',
        }],
      },
      plan(),
    )).toThrow(/only allowlisted capability sockets may cross the VM boundary/);

    // Rebinding an allowlisted guest path to a different host socket is equally
    // refused.
    expect(() => applyAppleContainerTransportToRunSpec(
      {
        ...baseSpec,
        socketMounts: [{
          hostPath: '/tmp/other.sock',
          containerPath: `${APPLE_CONTAINER_TRANSPORT_GUEST_DIRECTORY}/squid.sock`,
        }],
      },
      plan(),
    )).toThrow(/only allowlisted capability sockets may cross the VM boundary/);
  });

  it('tolerates a socket mount that is byte-identical to a planned one', () => {
    const identical = applyAppleContainerTransportToRunSpec(
      {
        ...baseSpec,
        socketMounts: [{
          hostPath: '/tmp/awf-apple-abc123def456/squid.sock',
          containerPath: `${APPLE_CONTAINER_TRANSPORT_GUEST_DIRECTORY}/squid.sock`,
        }],
      },
      plan(),
    );
    expect(identical.socketMounts).toEqual(plan().socketMounts);
  });

  it('refuses a bind mount that would shadow the published sockets', () => {
    for (const target of [
      APPLE_CONTAINER_TRANSPORT_GUEST_DIRECTORY,
      `${APPLE_CONTAINER_TRANSPORT_GUEST_DIRECTORY}/squid.sock`,
    ]) {
      expect(() => applyAppleContainerTransportToRunSpec(
        { ...baseSpec, mounts: [{ source: '/tmp/decoy', target }] },
        plan(),
      )).toThrow(/would shadow the published capability sockets/);
    }
  });

  it('leaves unrelated bind mounts alone', () => {
    const merged = applyAppleContainerTransportToRunSpec(
      { ...baseSpec, mounts: [{ source: '/tmp/workspace', target: '/workspace' }] },
      plan(),
    );
    expect(merged.mounts).toEqual([{ source: '/tmp/workspace', target: '/workspace' }]);
  });

  it('does not mutate the input spec', () => {
    const spec: AppleContainerRunSpec = { ...baseSpec, env: { EXTRA: 'ok' }, socketMounts: [] };
    applyAppleContainerTransportToRunSpec(spec, plan());
    expect(spec.env).toEqual({ EXTRA: 'ok' });
    expect(spec.socketMounts).toEqual([]);
    expect(spec.network).toBeUndefined();
  });

  it('never publishes a Docker socket or a host network capability', () => {
    const argv = buildAppleContainerRunArgs(
      applyAppleContainerTransportToRunSpec(
        { ...baseSpec, mounts: [{ source: '/tmp/workspace', target: '/workspace' }] },
        plan(),
      ),
    );
    expect(argv.join(' ')).not.toContain('docker.sock');
    expect(argv.join(' ')).not.toContain('--cap-add');
    for (const token of argv) {
      if (!token.includes(':') || !token.endsWith('.sock')) continue;
      expect(token.startsWith('/tmp/awf-apple-abc123def456/')).toBe(true);
    }
  });
});
