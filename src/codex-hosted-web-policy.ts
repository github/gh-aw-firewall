import {
  HostedWebConfig,
  NormalizedHostedWebPolicy,
  normalizeHostedWebPolicy,
} from './hosted-web-policy';

export type CodexHostedWebConfig = HostedWebConfig;
type NormalizedCodexHostedWebPolicy = NormalizedHostedWebPolicy;

export function normalizeCodexHostedWebPolicy(
  config: CodexHostedWebConfig | undefined,
  source = 'config',
): NormalizedCodexHostedWebPolicy | undefined {
  return normalizeHostedWebPolicy(config, 'codex', source);
}
