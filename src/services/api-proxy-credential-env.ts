import { WrapperConfig } from '../types';
import { NetworkConfig } from './squid-service';
import { buildOpenAiCredentialEnv } from './credentials/openai-credential-env';
import { buildAnthropicCredentialEnv } from './credentials/anthropic-credential-env';
import { buildCopilotCredentialEnv } from './credentials/copilot-credential-env';
import { buildGeminiCredentialEnv } from './credentials/gemini-credential-env';

interface ApiProxyCredentialEnvParams {
  config: WrapperConfig;
  networkConfig: NetworkConfig;
}

export function buildAgentCredentialEnv(params: ApiProxyCredentialEnvParams): Record<string, string> {
  const { config, networkConfig } = params;
  if (!networkConfig.proxyIp) {
    throw new Error('buildAgentCredentialEnv: networkConfig.proxyIp is required');
  }

  const agentEnvAdditions: Record<string, string> = {
    // AWF_API_PROXY_IP is used by setup-iptables.sh to allow agent→api-proxy traffic
    // Use IP address instead of hostname for BASE_URLs since Docker DNS may not resolve
    // container names in chroot mode
    AWF_API_PROXY_IP: networkConfig.proxyIp,
  };

  Object.assign(agentEnvAdditions, buildOpenAiCredentialEnv({ config, proxyIp: networkConfig.proxyIp }));
  Object.assign(agentEnvAdditions, buildAnthropicCredentialEnv({ config, proxyIp: networkConfig.proxyIp }));
  Object.assign(agentEnvAdditions, buildCopilotCredentialEnv({ config, proxyIp: networkConfig.proxyIp }));
  Object.assign(agentEnvAdditions, buildGeminiCredentialEnv({ config, proxyIp: networkConfig.proxyIp }));

  return agentEnvAdditions;
}
