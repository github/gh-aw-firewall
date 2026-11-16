import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

const facadePath = path.join(__dirname, 'cloud-hypervisor-enclave-live-smoke.js');
const facade = require(facadePath);

describe('enclave smoke compatibility facade', () => {
  it('preserves the complete public export surface', () => {
    expect(Object.keys(facade).sort()).toEqual([
      'GATEWAY_CONTAINER', 'GATEWAY_IMAGE', 'RELEASE_ASSETS',
      'acceptanceCheck', 'assertCanonicalToolError', 'assertExpectedToolResult',
      'assertNoSentinelLeak', 'assertNoSuccessfulResult', 'assertNoVmResidue',
      'assertProfileInitialize', 'assertProfileTools', 'assertRecoveredInvocation',
      'assertReleaseAssets', 'assertUnifiedProfiles', 'buildAgentEnospcProbe',
      'buildAgentGuestProbe', 'buildConstantObjectSchema', 'buildEnospcProbeScript',
      'buildOomProbeScript', 'buildScopedGithubGuestProbe', 'buildScriptGuestProbe',
      'captureContainerLogs', 'emitStartupDiagnostic', 'failedSpawns',
      'killAwfForRecovery', 'makeConfig', 'makeGithubFixtureCapability',
      'observeInvocationRecords', 'parsePublicToolResult', 'prepareAcceptanceArtifacts',
      'prepareReleaseArtifacts', 'publicMcpFailureReason', 'readCrashRecoveryBaseline',
      'readPrimaryVmProgress', 'readRecoveredInvocation', 'releaseTag',
      'removeGatewayFixture', 'removePrivateAwfLogs', 'reportFailure', 'requestMcp',
      'resourceDiscoveryEvidence', 'resourceRecords', 'spawnAwf', 'startGatewayFixture',
      'startupDiagnostic', 'startupEvidence', 'startupSnapshot', 'stopAwf',
      'toAwfConfig', 'trackAwfChild', 'verifyPrimaryVmIdentity', 'waitForBroker',
      'waitForDockerPrimaryReadiness', 'waitForHostGatewayReadiness',
      'waitForInvocationOutcome', 'waitForInvocationRecord', 'waitForPrimaryVmReadiness',
      'waitForVmCleanup', 'withCrashRecoveryCleanup',
    ].sort());
  });

  it.each([
    ['constants', ['GATEWAY_CONTAINER', 'GATEWAY_IMAGE', 'RELEASE_ASSETS']],
    ['artifacts', ['prepareReleaseArtifacts', 'prepareAcceptanceArtifacts', 'releaseTag',
      'assertReleaseAssets', 'assertUnifiedProfiles']],
    ['commands', ['captureContainerLogs']],
    ['diagnostic-files', ['assertNoSentinelLeak']],
    ['runner', ['reportFailure']],
    ['mcp-client', ['requestMcp', 'parsePublicToolResult', 'publicMcpFailureReason', 'acceptanceCheck',
      'assertCanonicalToolError', 'assertExpectedToolResult', 'assertProfileInitialize', 'assertProfileTools']],
    ['startup-evidence', ['startupEvidence', 'emitStartupDiagnostic', 'startupDiagnostic',
      'startupSnapshot', 'waitForBroker', 'waitForHostGatewayReadiness', 'failedSpawns', 'trackAwfChild']],
    ['vm-readiness', ['waitForPrimaryVmReadiness', 'verifyPrimaryVmIdentity', 'assertNoVmResidue',
      'waitForVmCleanup', 'waitForDockerPrimaryReadiness', 'readPrimaryVmProgress']],
    ['guest-probes', ['buildAgentGuestProbe', 'buildEnospcProbeScript', 'buildScopedGithubGuestProbe',
      'buildAgentEnospcProbe', 'buildConstantObjectSchema', 'buildOomProbeScript', 'buildScriptGuestProbe']],
    ['crash-recovery', ['observeInvocationRecords', 'assertRecoveredInvocation', 'withCrashRecoveryCleanup',
      'assertNoSuccessfulResult', 'killAwfForRecovery', 'resourceRecords', 'readRecoveredInvocation',
      'readCrashRecoveryBaseline', 'resourceDiscoveryEvidence', 'waitForInvocationRecord', 'waitForInvocationOutcome']],
    ['fixtures', ['makeConfig', 'makeGithubFixtureCapability', 'spawnAwf', 'stopAwf',
      'removeGatewayFixture', 'startGatewayFixture', 'removePrivateAwfLogs', 'toAwfConfig']],
  ])('re-exports %s helpers without wrappers or duplicate state', (moduleName, names) => {
    const helpers = require(path.join(__dirname, 'enclave-smoke', moduleName as string));
    for (const name of names) expect(facade[name]).toBe(helpers[name]);
  });

  it('shares MCP failure metadata across direct and facade consumers', () => {
    const mcp = require(path.join(__dirname, 'enclave-smoke/mcp-client'));
    const error = mcp.mcpFailure('response-missing');
    expect(facade.publicMcpFailureReason(error)).toBe('response-missing');
    expect(() => facade.parsePublicToolResult(undefined, 1)).toThrow('Public enclave MCP request failed');
  });

  it('can be required by plain Node without starting the live runner', () => {
    expect(execFileSync(process.execPath, ['-e',
      'require(process.argv[1]); process.stdout.write("loaded");', facadePath,
    ], { encoding: 'utf8', timeout: 10_000 })).toBe('loaded');
  });

  it('has no circular dependencies among focused helper modules', () => {
    const directory = path.join(__dirname, 'enclave-smoke');
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (file: string) => {
      expect(visiting.has(file)).toBe(false);
      if (visited.has(file)) return;
      visiting.add(file);
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(/require\(['"](\.\/[^'"]+)['"]\)/g)) {
        visit(require.resolve(path.resolve(path.dirname(file), match[1])));
      }
      visiting.delete(file);
      visited.add(file);
    };
    for (const name of fs.readdirSync(directory).filter(name => name.endsWith('.js'))) {
      visit(path.join(directory, name));
    }
  });
});
