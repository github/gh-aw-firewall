// Re-export public API for backwards compatibility.
// Only production-consumed symbols are re-exported here. Test files should
// import directly from the source modules (host-env, compose-generator, etc.).

export {
  setAwfDockerHost,
  getLocalDockerEnv,
  parseDifcProxyHost,
} from './host-env';

export { writeConfigs } from './config-writer';

export {
  startContainers,
  runAgentCommand,
  fastKillAgentContainer,
} from './container-lifecycle';

export {
  collectDiagnosticLogs,
  stopContainers,
  preserveIptablesAudit,
  cleanup,
} from './container-cleanup';
