import * as path from 'path';
import { WrapperConfig } from './types';

export interface LogPaths {
  squidLogs: string;
  sessionState: string;
  agentLogs: string;
  apiProxyLogs: string;
  cliProxyLogs: string;
}

/**
 * Resolves all log/state directory paths from WrapperConfig.
 * Centralizes the conditional proxyLogsDir/sessionStateDir/workDir logic
 * so compose-generator and config-writer always agree on paths.
 */
export function resolveLogPaths(config: WrapperConfig): LogPaths {
  return {
    squidLogs: config.proxyLogsDir || path.join(config.workDir, 'squid-logs'),
    sessionState: config.sessionStateDir || path.join(config.workDir, 'agent-session-state'),
    agentLogs: path.join(config.workDir, 'agent-logs'),
    apiProxyLogs: config.proxyLogsDir
      ? path.join(config.proxyLogsDir, 'api-proxy-logs')
      : path.join(config.workDir, 'api-proxy-logs'),
    cliProxyLogs: config.proxyLogsDir
      ? path.join(config.proxyLogsDir, 'cli-proxy-logs')
      : path.join(config.workDir, 'cli-proxy-logs'),
  };
}
