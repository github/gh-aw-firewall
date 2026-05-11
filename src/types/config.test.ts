import {
  API_PROXY_PORTS,
  API_PROXY_HEALTH_PORT,
  CLI_PROXY_PORT,
} from './config';

import type {
  WrapperConfig,
  ContainerImageOptions,
  NetworkOptions,
  VolumeOptions,
  SecurityOptions,
  ApiProxyOptions,
  RateLimitOptions,
  RuntimeOptions,
} from './config';

describe('types/config re-exports', () => {
  const assertAssignable = <T>(_value: T): void => {};

  it('should preserve runtime port constants', () => {
    expect(API_PROXY_PORTS.OPENAI).toBe(10000);
    expect(API_PROXY_HEALTH_PORT).toBe(API_PROXY_PORTS.OPENAI);
    expect(CLI_PROXY_PORT).toBe(11000);
  });

  it('should expose WrapperConfig as an intersection of domain options', () => {
    const config: WrapperConfig = {
      allowedDomains: ['github.com'],
      agentCommand: 'echo test',
      logLevel: 'info',
      keepContainers: false,
      workDir: '/tmp/workdir',
    };

    assertAssignable<ContainerImageOptions>(config);
    assertAssignable<NetworkOptions>(config);
    assertAssignable<VolumeOptions>(config);
    assertAssignable<SecurityOptions>(config);
    assertAssignable<ApiProxyOptions>(config);
    assertAssignable<RateLimitOptions>(config);
    assertAssignable<RuntimeOptions>(config);

    expect(config.allowedDomains).toEqual(['github.com']);
  });
});
