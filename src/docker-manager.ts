// Re-export public API for backwards compatibility.
// Symbols previously exported from the original docker-manager.ts are listed
// explicitly here to avoid unintentionally widening the public API surface with
// internal-only constants such as SQUID_PORT, *_CONTAINER_NAME, etc.

export {
  AGENT_CONTAINER_NAME,
  ACT_PRESET_BASE_IMAGE,
  MIN_REGULAR_UID,
  setAwfDockerHost,
  getLocalDockerEnv,
  validateIdNotInSystemRange,
  getSafeHostUid,
  getSafeHostGid,
  getRealUserHome,
  extractGhHostFromServerUrl,
  readGitHubPathEntries,
  readGitHubEnvEntries,
  parseGitHubEnvFile,
  mergeGitHubPathEntries,
  readEnvFile,
  subnetsOverlap,
  type SslConfig,
  stripScheme,
  parseDifcProxyHost,
} from './host-env';

export { generateDockerCompose } from './compose-generator';

export {
  writeConfigs,
  startContainers,
  runAgentCommand,
  fastKillAgentContainer,
  isAgentExternallyKilled,
  resetAgentExternallyKilled,
} from './container-lifecycle';

export {
  collectDiagnosticLogs,
  stopContainers,
  preserveIptablesAudit,
  cleanup,
} from './container-cleanup';
