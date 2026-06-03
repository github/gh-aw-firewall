import { SQUID_PORT } from '../../constants';
import { getRealUserHome } from '../../host-identity';
import { AgentEnvironmentParams } from './types';

export function buildCoreEnvironment(params: AgentEnvironmentParams): Record<string, string> {
  const { config, networkConfig } = params;
  const homeDir = getRealUserHome();

  return {
    HTTP_PROXY: `http://${networkConfig.squidIp}:${SQUID_PORT}`,
    HTTPS_PROXY: `http://${networkConfig.squidIp}:${SQUID_PORT}`,
    https_proxy: `http://${networkConfig.squidIp}:${SQUID_PORT}`,
    SQUID_PROXY_HOST: 'squid-proxy',
    SQUID_PROXY_PORT: SQUID_PORT.toString(),
    HOME: homeDir,
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    ...(config.tty ? {
      FORCE_COLOR: '1',
      TERM: 'xterm-256color',
      COLUMNS: '120',
    } : {
      NO_COLOR: '1',
    }),
    AWF_ONE_SHOT_TOKENS: 'COPILOT_GITHUB_TOKEN,GITHUB_TOKEN,GH_TOKEN,GITHUB_API_TOKEN,GITHUB_PAT,GH_ACCESS_TOKEN,OPENAI_API_KEY,OPENAI_KEY,ANTHROPIC_API_KEY,CLAUDE_API_KEY,CODEX_API_KEY,COPILOT_PROVIDER_API_KEY,OTEL_EXPORTER_OTLP_HEADERS,OTEL_EXPORTER_OTLP_TRACES_HEADERS,OTEL_EXPORTER_OTLP_METRICS_HEADERS,OTEL_EXPORTER_OTLP_LOGS_HEADERS',
  };
}
