import {
  APPLE_CONTAINER_HV_SUPPORT_SYSCTL,
  APPLE_CONTAINER_MINIMUM_MACOS_MAJOR,
  AppleContainerHostError,
  assertAppleContainerHostEligibility,
  collectAppleContainerHostFacts,
  evaluateAppleContainerHostEligibility,
  parseHypervisorSupport,
  parseMacosMajorVersion,
  type AppleContainerHostFacts,
} from './host-facts';

function facts(overrides: Partial<AppleContainerHostFacts> = {}): AppleContainerHostFacts {
  return {
    platform: 'darwin',
    arch: 'arm64',
    macosProductVersion: '26.1',
    hypervisorSupported: true,
    ...overrides,
  };
}

describe('parseMacosMajorVersion', () => {
  it.each([
    ['26', 26],
    ['26.1', 26],
    ['26.1.1', 26],
    [' 15.5 ', 15],
  ])('parses %j as %p', (value, expected) => {
    expect(parseMacosMajorVersion(value)).toBe(expected);
  });

  it.each(['', 'sonoma', '26.x', 'Version 26'])('throws on %j', (value) => {
    expect(() => parseMacosMajorVersion(value)).toThrow(/Could not parse macOS product version/);
  });
});

describe('parseHypervisorSupport', () => {
  it('treats a literal 1 as supported', () => {
    expect(parseHypervisorSupport('1\n')).toBe(true);
  });

  it.each(['0', '', 'yes', '11', 'true'])('treats %j as unsupported', (value) => {
    expect(parseHypervisorSupport(value)).toBe(false);
  });
});

describe('evaluateAppleContainerHostEligibility', () => {
  it('accepts a supported host', () => {
    expect(evaluateAppleContainerHostEligibility(facts())).toEqual({ eligible: true });
  });

  it('reports a non-Darwin platform first, before any other cause', () => {
    const result = evaluateAppleContainerHostEligibility(
      facts({ platform: 'linux', arch: 'x64', macosProductVersion: '', hypervisorSupported: false }),
    );
    expect(result).toMatchObject({ eligible: false, code: 'platform' });
  });

  it('rejects Intel macOS with an architecture cause', () => {
    const result = evaluateAppleContainerHostEligibility(facts({ arch: 'x64' }));
    expect(result).toMatchObject({ eligible: false, code: 'architecture' });
    expect((result as { reason: string }).reason).toMatch(/Apple Silicon/);
  });

  it('rejects macOS older than the minimum', () => {
    const result = evaluateAppleContainerHostEligibility(
      facts({ macosProductVersion: `${APPLE_CONTAINER_MINIMUM_MACOS_MAJOR - 1}.6` }),
    );
    expect(result).toMatchObject({ eligible: false, code: 'macos-version' });
    expect((result as { reason: string }).reason).toMatch(/25\.6/);
  });

  it('accepts a macOS version newer than the minimum', () => {
    expect(
      evaluateAppleContainerHostEligibility(
        facts({ macosProductVersion: `${APPLE_CONTAINER_MINIMUM_MACOS_MAJOR + 1}.0` }),
      ),
    ).toEqual({ eligible: true });
  });

  it('reports an unparseable macOS version as a version failure rather than throwing', () => {
    const result = evaluateAppleContainerHostEligibility(facts({ macosProductVersion: 'unknown' }));
    expect(result).toMatchObject({ eligible: false, code: 'macos-version' });
  });

  it('rejects a host without Virtualization.framework support', () => {
    const result = evaluateAppleContainerHostEligibility(facts({ hypervisorSupported: false }));
    expect(result).toMatchObject({ eligible: false, code: 'hypervisor' });
    const { reason } = result as { reason: string };
    expect(reason).toContain(APPLE_CONTAINER_HV_SUPPORT_SYSCTL);
    expect(reason).toMatch(/self-hosted bare-metal Apple Silicon runner/);
  });
});

describe('assertAppleContainerHostEligibility', () => {
  it('does not throw for a supported host', () => {
    expect(() => assertAppleContainerHostEligibility(facts())).not.toThrow();
  });

  it('throws an AppleContainerHostError carrying the cause code', () => {
    expect.assertions(2);
    try {
      assertAppleContainerHostEligibility(facts({ hypervisorSupported: false }));
    } catch (error) {
      expect(error).toBeInstanceOf(AppleContainerHostError);
      expect((error as AppleContainerHostError).code).toBe('hypervisor');
    }
  });
});

describe('collectAppleContainerHostFacts', () => {
  it('short-circuits on a non-Darwin platform without spawning Darwin-only tools', async () => {
    const readProductVersion = jest.fn();
    const readHypervisorSupport = jest.fn();

    const result = await collectAppleContainerHostFacts({
      platform: 'linux',
      arch: 'x64',
      readProductVersion,
      readHypervisorSupport,
    });

    expect(result).toEqual({
      platform: 'linux',
      arch: 'x64',
      macosProductVersion: '',
      hypervisorSupported: false,
    });
    expect(readProductVersion).not.toHaveBeenCalled();
    expect(readHypervisorSupport).not.toHaveBeenCalled();
  });

  it('collects and trims probe output on Darwin', async () => {
    const result = await collectAppleContainerHostFacts({
      platform: 'darwin',
      arch: 'arm64',
      readProductVersion: async () => '26.1.1\n',
      readHypervisorSupport: async () => '1\n',
    });

    expect(result).toEqual({
      platform: 'darwin',
      arch: 'arm64',
      macosProductVersion: '26.1.1',
      hypervisorSupported: true,
    });
  });

  it('maps a sw_vers failure to a macos-version host error', async () => {
    const promise = collectAppleContainerHostFacts({
      platform: 'darwin',
      arch: 'arm64',
      readProductVersion: async () => {
        throw new Error('spawn ENOENT');
      },
      readHypervisorSupport: async () => '1',
    });

    await expect(promise).rejects.toThrow(/Could not determine the macOS version.*spawn ENOENT/);
    await expect(promise).rejects.toMatchObject({ code: 'macos-version' });
  });

  it('maps a sysctl failure to a hypervisor host error', async () => {
    const promise = collectAppleContainerHostFacts({
      platform: 'darwin',
      arch: 'arm64',
      readProductVersion: async () => '26.0',
      readHypervisorSupport: async () => {
        throw new Error('unknown oid');
      },
    });

    await expect(promise).rejects.toThrow(new RegExp(APPLE_CONTAINER_HV_SUPPORT_SYSCTL));
    await expect(promise).rejects.toMatchObject({ code: 'hypervisor' });
  });

  it('records an unsupported hypervisor rather than throwing', async () => {
    const result = await collectAppleContainerHostFacts({
      platform: 'darwin',
      arch: 'arm64',
      readProductVersion: async () => '26.0',
      readHypervisorSupport: async () => '0',
    });

    expect(result.hypervisorSupported).toBe(false);
    expect(evaluateAppleContainerHostEligibility(result)).toMatchObject({ code: 'hypervisor' });
  });
});
