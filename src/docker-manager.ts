// Re-export public API for backwards compatibility.
// Symbols previously exported from the original docker-manager.ts are listed
// explicitly here to avoid unintentionally widening the public API surface with
// internal-only constants such as SQUID_PORT, *_CONTAINER_NAME, etc.

export {
  setAwfDockerHost,
  getLocalDockerEnv,
  parseDifcProxyHost,
} from './host-env';

export {
  fastKillAgentContainer,
} from './container-lifecycle';

export {
  collectDiagnosticLogs,
  stopContainers,
  preserveIptablesAudit,
  cleanup,
} from './container-cleanup';
