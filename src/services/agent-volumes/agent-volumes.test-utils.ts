import type { WrapperConfig } from '../../types';

export function makeAgentVolumeConfig(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    allowDomains: 'example.com',
    agentCommand: 'echo test',
    workDir: '/tmp/awf-test',
    ...overrides,
  } as WrapperConfig;
}
