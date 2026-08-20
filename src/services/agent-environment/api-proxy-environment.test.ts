import { logger } from '../../logger';
import { baseConfig, mockNetworkConfig } from '../../test-helpers/docker-test-fixtures.test-utils';
import { WrapperConfig } from '../../types';
import { buildApiProxyEnvironment } from './api-proxy-environment';

jest.mock('../../logger', () => ({
  logger: {
    warn: jest.fn(),
  },
}));

jest.mock('../../host-identity', () => ({
  getRealUserHome: jest.fn().mockReturnValue('/home/runner'),
  getSafeHostUid: jest.fn().mockReturnValue('1000'),
  getSafeHostGid: jest.fn().mockReturnValue('1000'),
  isNativeRootWithoutSudo: jest.fn(),
}));

const hostIdentity = jest.requireMock('../../host-identity') as {
  isNativeRootWithoutSudo: jest.Mock;
};

function run(config: Partial<WrapperConfig> = {}): Record<string, string> {
  const environment: Record<string, string> = {};
  buildApiProxyEnvironment({
    config: { ...baseConfig, workDir: '/tmp/awf-work', ...config },
    networkConfig: mockNetworkConfig,
    dnsServers: ['8.8.8.8'],
    environment,
  });
  return environment;
}

describe('buildApiProxyEnvironment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    hostIdentity.isNativeRootWithoutSudo.mockReturnValue(false);
  });

  it('warns when native root falls back to the default sandbox identity', () => {
    hostIdentity.isNativeRootWithoutSudo.mockReturnValue(true);

    const env = run();

    expect(env.AWF_USER_UID).toBe('1000');
    expect(env.AWF_USER_GID).toBe('1000');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('running as root with no SUDO_UID')
    );
  });

  it('does not warn for non-native-root identity resolution', () => {
    run();

    expect(logger.warn).not.toHaveBeenCalled();
  });
});
