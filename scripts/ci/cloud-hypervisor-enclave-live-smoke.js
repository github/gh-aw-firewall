'use strict';

const {
  GATEWAY_CONTAINER, GATEWAY_IMAGE, RELEASE_ASSETS, FAILURE_STAGES,
} = require('./enclave-smoke/constants');
const {
  emitStartupDiagnostic, startupEvidence, startupDiagnostic, startupSnapshot,
  waitForBroker, waitForHostGatewayReadiness, failedSpawns, trackAwfChild,
} = require('./enclave-smoke/startup-evidence');
const {
  prepareReleaseArtifacts, prepareAcceptanceArtifacts, releaseTag,
  assertReleaseAssets, assertUnifiedProfiles,
} = require('./enclave-smoke/artifacts');
const {
  removeGatewayFixture, spawnAwf, startGatewayFixture, removePrivateAwfLogs,
  stopAwf, makeConfig, toAwfConfig, makeGithubFixtureCapability,
} = require('./enclave-smoke/fixtures');
const {
  waitForVmCleanup, waitForPrimaryVmReadiness, waitForDockerPrimaryReadiness,
  readPrimaryVmProgress, verifyPrimaryVmIdentity, assertNoVmResidue,
} = require('./enclave-smoke/vm-readiness');
const { main, reportFailure } = require('./enclave-smoke/runner');
const {
  assertProfileTools, assertProfileInitialize, assertExpectedToolResult,
  parsePublicToolResult, publicMcpFailureReason, assertCanonicalToolError,
  acceptanceCheck, requestMcp,
} = require('./enclave-smoke/mcp-client');
const { captureContainerLogs } = require('./enclave-smoke/commands');
const { assertNoSentinelLeak } = require('./enclave-smoke/diagnostic-files');
const {
  assertRecoveredInvocation, assertNoSuccessfulResult, killAwfForRecovery,
  withCrashRecoveryCleanup, observeInvocationRecords, resourceRecords,
  readRecoveredInvocation, readCrashRecoveryBaseline, resourceDiscoveryEvidence,
  waitForInvocationRecord, waitForInvocationOutcome,
} = require('./enclave-smoke/crash-recovery');
const {
  buildAgentGuestProbe, buildScopedGithubGuestProbe, buildAgentEnospcProbe,
  buildConstantObjectSchema, buildEnospcProbeScript, buildOomProbeScript,
  buildScriptGuestProbe,
} = require('./enclave-smoke/guest-probes');

if (require.main === module) {
  const failureContext = { stage: FAILURE_STAGES.RUNNER };
  main(failureContext).catch((error) => reportFailure(error, failureContext.stage));
}

module.exports = {
  GATEWAY_CONTAINER,
  GATEWAY_IMAGE,
  emitStartupDiagnostic,
  startupEvidence,
  prepareReleaseArtifacts,
  prepareAcceptanceArtifacts,
  releaseTag,
  removeGatewayFixture,
  spawnAwf,
  startGatewayFixture,
  waitForVmCleanup,
  waitForPrimaryVmReadiness,
  waitForDockerPrimaryReadiness,
  readPrimaryVmProgress,
  verifyPrimaryVmIdentity,
  startupDiagnostic,
  startupSnapshot,
  waitForBroker,
  waitForHostGatewayReadiness,
  failedSpawns,
  removePrivateAwfLogs,
  stopAwf,
  reportFailure,
  trackAwfChild,
  assertNoVmResidue,
  RELEASE_ASSETS,
  assertReleaseAssets,
  assertUnifiedProfiles,
  makeConfig,
  toAwfConfig,
  assertProfileTools,
  assertProfileInitialize,
  captureContainerLogs,
  assertNoSentinelLeak,
  assertExpectedToolResult,
  assertRecoveredInvocation,
  assertNoSuccessfulResult,
  killAwfForRecovery,
  withCrashRecoveryCleanup,
  buildAgentGuestProbe,
  makeGithubFixtureCapability,
  buildScopedGithubGuestProbe,
  buildAgentEnospcProbe,
  buildConstantObjectSchema,
  buildEnospcProbeScript,
  buildOomProbeScript,
  buildScriptGuestProbe,
  parsePublicToolResult,
  publicMcpFailureReason,
  assertCanonicalToolError,
  acceptanceCheck,
  observeInvocationRecords,
  resourceRecords,
  readRecoveredInvocation,
  readCrashRecoveryBaseline,
  resourceDiscoveryEvidence,
  waitForInvocationRecord,
  waitForInvocationOutcome,
  requestMcp,
};
