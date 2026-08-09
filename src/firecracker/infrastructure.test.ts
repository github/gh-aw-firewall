import {
  resolveFirecrackerInfrastructure,
  type FirecrackerInfrastructureDependencies,
} from './infrastructure';

function networkInspection(
  overrides: Record<string, unknown> = {},
): Array<Record<string, unknown>> {
  return [{
    Name: 'awf-net',
    Id: 'a'.repeat(64),
    Driver: 'bridge',
    Scope: 'local',
    Internal: true,
    Options: {},
    IPAM: {
      Config: [{ Subnet: '172.30.0.0/24', Gateway: '172.30.0.1' }],
    },
    Containers: {
      squid: { Name: 'awf-squid', IPv4Address: '172.30.0.10/24' },
      proxy: { Name: 'awf-api-proxy', IPv4Address: '172.30.0.30/24' },
    },
    ...overrides,
  }];
}

function dependencies(
  inspection: unknown = networkInspection(),
): jest.Mocked<FirecrackerInfrastructureDependencies> {
  return {
    inspectNetwork: jest.fn().mockResolvedValue(inspection),
    inspectLink: jest.fn(async (bridgeName: string) => [{
      ifname: bridgeName,
      linkinfo: { info_kind: 'bridge' },
    }]),
  };
}

describe('Firecracker infrastructure discovery', () => {
  it('derives the Docker bridge from the live network ID and revalidates targets', async () => {
    const deps = dependencies();
    const resolved = await resolveFirecrackerInfrastructure(true, deps);

    expect(resolved).toEqual(expect.objectContaining({
      networkId: 'a'.repeat(64),
      bridgeName: `br-${'a'.repeat(12)}`,
      subnet: '172.30.0.0/24',
      gateway: '172.30.0.1',
      squidIp: '172.30.0.10',
      apiProxyIp: '172.30.0.30',
    }));
    await resolved.revalidate();
    expect(deps.inspectNetwork).toHaveBeenCalledTimes(2);
    expect(deps.inspectLink).toHaveBeenCalledWith(`br-${'a'.repeat(12)}`);
  });

  it('rejects ambiguous, non-internal, or address-shifted topology', async () => {
    await expect(resolveFirecrackerInfrastructure(
      true,
      dependencies([networkInspection()[0], networkInspection()[0]]),
    )).rejects.toThrow(/exactly one Docker network inspection/);

    await expect(resolveFirecrackerInfrastructure(
      true,
      dependencies(networkInspection({ Internal: false })),
    )).rejects.toThrow(/Unexpected Firecracker infrastructure topology/);

    await expect(resolveFirecrackerInfrastructure(
      true,
      dependencies(networkInspection({
        Containers: {
          squid: { Name: 'awf-squid', IPv4Address: '172.30.0.99/24' },
          proxy: { Name: 'awf-api-proxy', IPv4Address: '172.30.0.30/24' },
        },
      })),
    )).rejects.toThrow(/Unexpected "awf-squid" address/);
  });

  it('rejects an accidentally composed primary agent', async () => {
    await expect(resolveFirecrackerInfrastructure(
      true,
      dependencies(networkInspection({
        Containers: {
          squid: { Name: 'awf-squid', IPv4Address: '172.30.0.10/24' },
          proxy: { Name: 'awf-api-proxy', IPv4Address: '172.30.0.30/24' },
          agent: { Name: 'awf-agent', IPv4Address: '172.30.0.20/24' },
        },
      })),
    )).rejects.toThrow(/Unexpected Compose agent/);
  });

  it('fails when topology changes between resolution and VM setup', async () => {
    const deps = dependencies();
    deps.inspectNetwork
      .mockResolvedValueOnce(networkInspection())
      .mockResolvedValueOnce(networkInspection({ Id: 'b'.repeat(64) }));
    const resolved = await resolveFirecrackerInfrastructure(true, deps);

    await expect(resolved.revalidate()).rejects.toThrow(/topology changed/);
  });
});
