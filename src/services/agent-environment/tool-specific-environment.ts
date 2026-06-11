import * as path from 'path';
import { COPILOT_PLACEHOLDER_TOKEN } from '../../constants/placeholders';
import { logger } from '../../logger';
import { extractCommandBinaryName, shouldUseDockerHostStaging } from '../agent-volumes/docker-host-staging';
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
  const stagedBinaryName = extractCommandBinaryName(config.agentCommand);
  const hasCopilotProviderApiKey = !!config.copilotProviderApiKey;

  if (config.chrootIdentity?.home) {
    environment.AWF_CHROOT_IDENTITY_HOME = config.chrootIdentity.home;
  }
  if (config.chrootIdentity?.user) {
    environment.AWF_CHROOT_IDENTITY_USER = config.chrootIdentity.user;
  }
  if (config.chrootIdentity?.uid !== undefined) {
    environment.AWF_CHROOT_IDENTITY_UID = String(config.chrootIdentity.uid);
  }
  if (config.chrootIdentity?.gid !== undefined) {
    environment.AWF_CHROOT_IDENTITY_GID = String(config.chrootIdentity.gid);
  }

  // Any Copilot signal (named command, GitHub token, or direct-BYOK key) means
  // the user is going to invoke Copilot CLI, which requires Node.js. Set
  // AWF_REQUIRE_NODE so the entrypoint emits a friendly preflight error when
  // node is missing — including the wrapped-script case where the basename
  // isn't literally "copilot".
  if (config.copilotGithubToken || hasCopilotProviderApiKey || isCopilotCommand) {
    environment.AWF_REQUIRE_NODE = '1';
  }

  if (isCodexCommand) {
    environment.AWF_PREFLIGHT_BINARY = 'codex';
  }

  if (stagedBinaryName && shouldUseDockerHostStaging(config.dockerHostPathPrefix)) {
    environment.AWF_STAGED_RUNNER_BINARY_NAME = stagedBinaryName;
  }

  // GitHub-token path: user supplied COPILOT_GITHUB_TOKEN. Mask it in the agent
  // so the real token (held by the sidecar) cannot leak via --env-all.
  // For GHE instances, use an empty string instead of the ghu_ placeholder because
  // GHE REST APIs reject the github.com-only ghu_ token format with "400: badly formatted".
  if (config.enableApiProxy && config.copilotGithubToken) {
    let copilotGhePlaceholder: string;
    try {
      const serverUrl = process.env.GITHUB_SERVER_URL;
      copilotGhePlaceholder = (serverUrl && new URL(serverUrl).hostname !== 'github.com') ? '' : COPILOT_PLACEHOLDER_TOKEN;
    } catch {
      copilotGhePlaceholder = COPILOT_PLACEHOLDER_TOKEN;
    }
    environment.COPILOT_GITHUB_TOKEN = copilotGhePlaceholder;
    logger.debug('COPILOT_GITHUB_TOKEN set to placeholder value (early) to prevent --env-all override');
  }

  // Direct-BYOK path: user supplied COPILOT_PROVIDER_API_KEY (pointing Copilot CLI
  // at an arbitrary upstream via COPILOT_PROVIDER_BASE_URL). The real key is
  // forwarded to the sidecar; the agent only sees a placeholder so the real value
  // cannot leak via --env-all.
  //
  // Set the placeholder whenever Copilot routes through the sidecar (either path),
  // and also whenever the user supplied a real COPILOT_PROVIDER_API_KEY (so it
  // never reaches the agent regardless of which other Copilot signals are present).
  if (config.enableApiProxy && (config.copilotGithubToken || hasCopilotProviderApiKey)) {
    environment.COPILOT_PROVIDER_API_KEY = COPILOT_PLACEHOLDER_TOKEN;
    logger.debug('COPILOT_PROVIDER_API_KEY set to placeholder value (early) to prevent --env-all override');
  }
}
