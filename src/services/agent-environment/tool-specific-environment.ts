import * as path from 'path';
import { COPILOT_PLACEHOLDER_TOKEN } from '../../constants/placeholders';
import { logger } from '../../logger';
import { WrapperConfig } from '../../types';

interface ToolEnvironmentParams {
  config: WrapperConfig;
  environment: Record<string, string>;
}

export function buildToolEnvironment(params: ToolEnvironmentParams): void {
  const { config, environment } = params;
  const commandExecutable = config.agentCommand.trim().split(/\s+/, 1)[0] || '';
  const commandExecutableBase = path.posix.basename(commandExecutable.replace(/\\/g, '/'));
  const isCopilotCommand = commandExecutableBase.toLowerCase() === 'copilot';
  const isCodexCommand = commandExecutableBase.toLowerCase() === 'codex';

  if (config.copilotGithubToken || config.copilotApiKey || isCopilotCommand) {
    environment.AWF_REQUIRE_NODE = '1';
  }

  if (isCodexCommand) {
    environment.AWF_PREFLIGHT_BINARY = 'codex';
  }

  if (config.enableApiProxy && config.copilotGithubToken) {
    environment.COPILOT_GITHUB_TOKEN = COPILOT_PLACEHOLDER_TOKEN;
    logger.debug('COPILOT_GITHUB_TOKEN set to placeholder value (early) to prevent --env-all override');
  }

  if (config.enableApiProxy && config.copilotApiKey) {
    environment.COPILOT_API_KEY = COPILOT_PLACEHOLDER_TOKEN;
    logger.debug('COPILOT_API_KEY set to placeholder value (early) to prevent --env-all override');
    environment.COPILOT_PROVIDER_API_KEY = COPILOT_PLACEHOLDER_TOKEN;
    logger.debug('COPILOT_PROVIDER_API_KEY set to placeholder value (early) to prevent --env-all override');
  }
}
