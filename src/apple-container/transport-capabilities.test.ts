import {
  APPLE_CONTAINER_INIT_ENTRYPOINT,
  APPLE_CONTAINER_TRANSPORT_CAPABILITIES,
  APPLE_CONTAINER_TRANSPORT_CONTRACT_VERSION,
  APPLE_CONTAINER_TRANSPORT_GUEST_DIRECTORY,
  APPLE_CONTAINER_TRANSPORT_MAX_CLI_VERSION_EXCLUSIVE,
  APPLE_CONTAINER_TRANSPORT_MIN_CLI_VERSION,
  APPLE_CONTAINER_VMINITD_PATH,
  appleContainerGuestEndpointUrl,
  appleContainerGuestSocketPath,
  assertAppleContainerTransportCliVersion,
  assertAppleContainerUpstreamEndpoint,
  getAppleContainerCapability,
  isAppleContainerCapabilityId,
} from './transport-capabilities';

describe('Apple Container transport capability allowlist', () => {
  it('is a closed set with unique ids, ports, and socket names', () => {
    const ids = new Set<string>();
    const ports = new Set<number>();
    const sockets = new Set<string>();
    for (const capability of APPLE_CONTAINER_TRANSPORT_CAPABILITIES) {
      expect(ids.has(capability.id)).toBe(false);
      expect(ports.has(capability.guestPort)).toBe(false);
      expect(sockets.has(capability.socketName)).toBe(false);
      ids.add(capability.id);
      ports.add(capability.guestPort);
      sockets.add(capability.socketName);
    }
    expect([...ids].sort()).toEqual([
      'api-proxy-anthropic',
      'api-proxy-copilot',
      'api-proxy-gemini',
      'api-proxy-openai',
      'cli-proxy',
      'mcp-gateway',
      'squid',
    ]);
  });

  it('bridges only the four discrete API proxy provider ports', () => {
    const apiPorts = APPLE_CONTAINER_TRANSPORT_CAPABILITIES
      .filter((capability) => capability.id.startsWith('api-proxy-'))
      .map((capability) => capability.guestPort)
      .sort((a, b) => a - b);
    expect(apiPorts).toEqual([10000, 10001, 10002, 10003]);
  });

  it('rejects capabilities that are not in the allowlist', () => {
    expect(() => getAppleContainerCapability('docker')).toThrow(/not in the allowlist/);
    expect(() => getAppleContainerCapability('host-network')).toThrow(/not in the allowlist/);
    expect(() => getAppleContainerCapability('')).toThrow(/not in the allowlist/);
    expect(isAppleContainerCapabilityId('docker')).toBe(false);
    expect(isAppleContainerCapabilityId('squid')).toBe(true);
  });

  it('cannot be mutated at runtime', () => {
    expect(Object.isFrozen(APPLE_CONTAINER_TRANSPORT_CAPABILITIES)).toBe(true);
    expect(Object.isFrozen(APPLE_CONTAINER_TRANSPORT_CAPABILITIES[0])).toBe(true);
  });

  it('places every socket inside the versioned guest directory', () => {
    expect(APPLE_CONTAINER_TRANSPORT_GUEST_DIRECTORY)
      .toBe(`/run/awf/transport/v${APPLE_CONTAINER_TRANSPORT_CONTRACT_VERSION}`);
    for (const capability of APPLE_CONTAINER_TRANSPORT_CAPABILITIES) {
      expect(appleContainerGuestSocketPath(capability.id))
        .toBe(`${APPLE_CONTAINER_TRANSPORT_GUEST_DIRECTORY}/${capability.socketName}`);
    }
  });

  it('exposes guest endpoints on loopback only', () => {
    for (const capability of APPLE_CONTAINER_TRANSPORT_CAPABILITIES) {
      expect(appleContainerGuestEndpointUrl(capability.id))
        .toBe(`http://127.0.0.1:${capability.guestPort}`);
    }
  });

  it('keeps the init entrypoint distinct from the relocated Apple init', () => {
    expect(APPLE_CONTAINER_INIT_ENTRYPOINT).toBe('/sbin/vminitd');
    expect(APPLE_CONTAINER_VMINITD_PATH).toBe('/sbin/vminitd.apple');
    expect(APPLE_CONTAINER_VMINITD_PATH).not.toBe(APPLE_CONTAINER_INIT_ENTRYPOINT);
  });
});

describe('assertAppleContainerUpstreamEndpoint', () => {
  it('accepts loopback and private IPv4 literals', () => {
    for (const host of ['127.0.0.1', '10.1.2.3', '172.30.0.10', '192.168.1.5']) {
      expect(assertAppleContainerUpstreamEndpoint({ host, port: 3128 }, 'test').host).toBe(host);
    }
  });

  it('accepts IPv6 loopback and unique-local addresses', () => {
    expect(assertAppleContainerUpstreamEndpoint({ host: '::1', port: 1 }, 'test').host).toBe('::1');
    expect(assertAppleContainerUpstreamEndpoint({ host: 'fd00::1', port: 1 }, 'test').host)
      .toBe('fd00::1');
  });

  it('rejects the cloud metadata address and other link-local addresses', () => {
    expect(() => assertAppleContainerUpstreamEndpoint(
      { host: '169.254.169.254', port: 80 },
      'metadata',
    )).toThrow(/not a loopback or private address/);
    expect(() => assertAppleContainerUpstreamEndpoint({ host: 'fe80::1', port: 80 }, 'metadata'))
      .toThrow(/not an IPv6 loopback or unique-local address/);
  });

  it('rejects public addresses', () => {
    expect(() => assertAppleContainerUpstreamEndpoint({ host: '8.8.8.8', port: 53 }, 'dns'))
      .toThrow(/not a loopback or private address/);
    expect(() => assertAppleContainerUpstreamEndpoint({ host: '2001:db8::1', port: 80 }, 'x'))
      .toThrow(/not an IPv6 loopback or unique-local address/);
  });

  it('rejects hostnames so the relay never resolves a name', () => {
    expect(() => assertAppleContainerUpstreamEndpoint({ host: 'localhost', port: 3128 }, 'x'))
      .toThrow(/must be an IP literal, not a name/);
    expect(() => assertAppleContainerUpstreamEndpoint({ host: 'awf-squid', port: 3128 }, 'x'))
      .toThrow(/must be an IP literal, not a name/);
  });

  it('rejects ambiguous octal-looking and out-of-range octets', () => {
    expect(() => assertAppleContainerUpstreamEndpoint({ host: '010.0.0.1', port: 1 }, 'x'))
      .toThrow(/must be an IP literal, not a name/);
    expect(() => assertAppleContainerUpstreamEndpoint({ host: '127.0.0.999', port: 1 }, 'x'))
      .toThrow(/must be an IP literal, not a name/);
  });

  it('rejects out-of-range and non-integer ports', () => {
    for (const port of [0, -1, 65_536, 1.5, Number.NaN]) {
      expect(() => assertAppleContainerUpstreamEndpoint({ host: '127.0.0.1', port }, 'x'))
        .toThrow(/port must be in 1\.\.65535/);
    }
  });

  it('rejects empty and non-string hosts', () => {
    expect(() => assertAppleContainerUpstreamEndpoint({ host: '', port: 1 }, 'x'))
      .toThrow(/must be an IP literal/);
    expect(() => assertAppleContainerUpstreamEndpoint(
      { host: undefined as unknown as string, port: 1 },
      'x',
    )).toThrow(/must be an IP literal/);
  });
});

describe('assertAppleContainerTransportCliVersion', () => {
  it('accepts versions inside the pinned window', () => {
    expect(assertAppleContainerTransportCliVersion(APPLE_CONTAINER_TRANSPORT_MIN_CLI_VERSION))
      .toBe(APPLE_CONTAINER_TRANSPORT_MIN_CLI_VERSION);
    expect(assertAppleContainerTransportCliVersion('0.9.9')).toBe('0.9.9');
  });

  it('rejects versions below the pinned minimum', () => {
    expect(() => assertAppleContainerTransportCliVersion('0.3.9')).toThrow(/or newer/);
  });

  it('rejects versions at or above the exclusive maximum', () => {
    expect(() => assertAppleContainerTransportCliVersion(
      APPLE_CONTAINER_TRANSPORT_MAX_CLI_VERSION_EXCLUSIVE,
    )).toThrow(/has not been validated/);
    expect(() => assertAppleContainerTransportCliVersion('2.0.0')).toThrow(/has not been validated/);
  });
});
