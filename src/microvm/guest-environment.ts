import { SQUID_PORT } from '../constants';
import type { WrapperConfig } from '../types';
import { buildAgentCredentialEnv } from '../services/api-proxy-credential-env';
import { buildAgentEnvironment } from '../services/agent-service';
import type { NetworkConfig } from '../services/squid-service';

export interface GuestEnvironmentOptions {
  config: WrapperConfig;
  networkConfig: NetworkConfig;
  home: string;
  workspace: string;
  runtimeName: string;
  runtimeDisplayName: string;
}

export function buildGuestEnvironment({
  config,
  networkConfig,
  home,
  workspace,
  runtimeName,
  runtimeDisplayName,
}: GuestEnvironmentOptions): Record<string, string> {
  const environment = buildAgentEnvironment({
    config,
    networkConfig,
    dnsServers: [],
  });
  if (config.enableApiProxy) {
    Object.assign(environment, buildAgentCredentialEnv({ config, networkConfig }));
  }
  Object.assign(environment, {
    HOME: home,
    PWD: workspace,
    AWF_WORKDIR: workspace,
    SQUID_PROXY_HOST: networkConfig.squidIp,
    HOSTNAME: `awf-${runtimeName}`,
    AWF_RUNTIME: runtimeName,
    // The shared container-runtime environment intentionally omits
    // lowercase http_proxy (curl on Ubuntu 22.04 ignores uppercase
    // HTTP_PROXY for plain HTTP, so HTTP falls through to iptables DNAT
    // -> Squid instead of an explicit proxy connection, which is what
    // keeps a blocked domain's Squid 403 page mapped to a real failure
    // exit code there). The BusyBox guest's wget has different,
    // guest-specific proxy-detection behavior: it reads only the
    // lowercase "http_proxy" env var for every protocol including
    // https (there is no https_proxy check in BusyBox's wget at all).
    // Every wget-based https:// case in this guest's own smoke coverage
    // either already relies on an explicit proxy connection or
    // explicitly unsets all proxy vars first, so this is safe here even
    // though it would not be for the container runtime's curl-based
    // HTTP assertions.
    http_proxy: `http://${networkConfig.squidIp}:${SQUID_PORT}`,
  });
  assertNoProviderSecrets(config, environment, runtimeDisplayName);
  return environment;
}

function assertNoProviderSecrets(
  config: WrapperConfig,
  environment: Readonly<Record<string, string>>,
  runtimeDisplayName: string,
): void {
  const secrets = [
    config.openaiApiKey,
    config.anthropicApiKey,
    config.copilotGithubToken,
    config.copilotProviderApiKey,
    config.geminiApiKey,
    config.googleApiKey,
    config.githubToken,
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  for (const [name, value] of Object.entries(environment)) {
    if (secrets.some((secret) => value === secret || value.includes(secret))) {
      throw new Error(
        `Refusing to pass a real provider credential through ${runtimeDisplayName} guest variable ${name}`,
      );
    }
  }
}
