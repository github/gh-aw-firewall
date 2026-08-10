import {
  resolveMicrovmInfrastructure,
  type MicrovmInfrastructureDependencies,
} from './infrastructure';
import execa from 'execa';

jest.mock('execa');

const mockedExeca = execa as jest.MockedFunction<typeof execa>;

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
): jest.Mocked<MicrovmInfrastructureDependencies> {
  return {
    inspectNetwork: jest.fn().mockResolvedValue(inspection),
    inspectLink: jest.fn(async (bridgeName: string) => [{
      ifname: bridgeName,
      linkinfo: { info_kind: 'bridge' },
    }]),
  };
}

describe('microVM infrastructure discovery', () => {
  beforeEach(() => {
    mockedExeca.mockReset();
  });

  it('uses the default Docker and host-link probes', async () => {
    mockedExeca
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify(networkInspection()),
        stderr: '',
      } as never)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify([{
          ifname: `br-${'a'.repeat(12)}`,
          linkinfo: { info_kind: 'bridge' },
        }]),
        stderr: '',
      } as never);

    await expect(resolveMicrovmInfrastructure(true)).resolves.toEqual(
      expect.objectContaining({ squidIp: '172.30.0.10', apiProxyIp: '172.30.0.30' }),
    );
    expect(mockedExeca).toHaveBeenNthCalledWith(
      1,
      'docker',
      ['network', 'inspect', 'awf-net'],
      expect.objectContaining({ reject: false, timeout: 10_000 }),
    );
    expect(mockedExeca).toHaveBeenNthCalledWith(
      2,
      'ip',
      ['-json', '-details', 'link', 'show', 'dev', `br-${'a'.repeat(12)}`],
      { reject: false, timeout: 5_000 },
    );
  });

  it('surfaces default Docker and link probe failures', async () => {
    mockedExeca.mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'network unavailable',
    } as never);
    await expect(resolveMicrovmInfrastructure(true))
      .rejects.toThrow(/Could not inspect.*network unavailable/);

    mockedExeca
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify(networkInspection()),
        stderr: '',
      } as never)
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: 'link unavailable',
      } as never);
    await expect(resolveMicrovmInfrastructure(true))
      .rejects.toThrow(/Could not inspect.*bridge.*link unavailable/);
  });

  it('derives the Docker bridge from the live network ID and revalidates targets', async () => {
    const deps = dependencies();
    const resolved = await resolveMicrovmInfrastructure(true, deps);

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
    expect(deps.inspectLink).toHaveBeenCalledWith(`br-${'a'.repeat(12)}`, undefined);
  });

  it('rejects ambiguous, non-internal, or address-shifted topology', async () => {
    await expect(resolveMicrovmInfrastructure(
      true,
      dependencies([networkInspection()[0], networkInspection()[0]]),
    )).rejects.toThrow(/exactly one Docker network inspection/);

    await expect(resolveMicrovmInfrastructure(
      true,
      dependencies(networkInspection({ Internal: false })),
    )).rejects.toThrow(/Unexpected microVM infrastructure topology/);

    await expect(resolveMicrovmInfrastructure(
      true,
      dependencies(networkInspection({
        Containers: {
          squid: { Name: 'awf-squid', IPv4Address: '172.30.0.99/24' },
          proxy: { Name: 'awf-api-proxy', IPv4Address: '172.30.0.30/24' },
        },
      })),
    )).rejects.toThrow(/Unexpected "awf-squid" address/);

    await expect(resolveMicrovmInfrastructure(
      true,
      dependencies(networkInspection({ Id: 'invalid' })),
    )).rejects.toThrow(/invalid network ID/);

    await expect(resolveMicrovmInfrastructure(
      true,
      dependencies(networkInspection({ IPAM: { Config: [] } })),
    )).rejects.toThrow(/must have exactly 172\.30\.0\.0\/24/);
  });

  it('validates the bridge and required service endpoint shape', async () => {
    const badLink = dependencies();
    badLink.inspectLink.mockResolvedValue([]);
    await expect(resolveMicrovmInfrastructure(true, badLink))
      .rejects.toThrow(/exactly one host bridge/);

    const nonBridge = dependencies();
    nonBridge.inspectLink.mockResolvedValue([{
      ifname: `br-${'a'.repeat(12)}`,
      linkinfo: { info_kind: 'veth' },
    }]);
    await expect(resolveMicrovmInfrastructure(true, nonBridge))
      .rejects.toThrow(/is not the Docker bridge/);

    await expect(resolveMicrovmInfrastructure(
      true,
      dependencies(networkInspection({ Containers: {} })),
    )).rejects.toThrow(/Expected exactly one "awf-squid" endpoint/);

    await expect(resolveMicrovmInfrastructure(
      true,
      dependencies(networkInspection({
        Options: { 'com.docker.network.bridge.name': 'unsafe bridge' },
      })),
    )).rejects.toThrow(/Unsafe microVM infrastructure bridge name/);

    await expect(resolveMicrovmInfrastructure(
      true,
      dependencies([null]),
    )).rejects.toThrow(/Docker network inspection is not an object/);
  });

  it('supports Squid-only infrastructure without an API proxy', async () => {
    const resolved = await resolveMicrovmInfrastructure(
      false,
      dependencies(networkInspection({
        Containers: {
          squid: { Name: 'awf-squid', IPv4Address: '172.30.0.10/24' },
        },
      })),
    );
    expect(resolved.apiProxyIp).toBeUndefined();
  });

  it('rejects an accidentally composed primary agent', async () => {
    await expect(resolveMicrovmInfrastructure(
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
    const resolved = await resolveMicrovmInfrastructure(true, deps);

    await expect(resolved.revalidate()).rejects.toThrow(/topology changed/);
  });
});
