import {
  HostedWebConfig,
  NormalizedHostedWebPolicy,
  normalizeHostedWebPolicy,
} from './hosted-web-policy';

export type ClaudeHostedWebConfig = HostedWebConfig;
export type NormalizedClaudeHostedWebPolicy = NormalizedHostedWebPolicy;

export function normalizeClaudeHostedWebPolicy(
  config: ClaudeHostedWebConfig | undefined,
  source = 'config',
): NormalizedClaudeHostedWebPolicy | undefined {
  return normalizeHostedWebPolicy(config, 'claude', source);
}
