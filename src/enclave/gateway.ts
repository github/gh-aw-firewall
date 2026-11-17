import execa from 'execa';
import { ENCLAVE_MCP_SERVER_CONTAINER_NAME } from '../constants';
import { getLocalDockerEnv } from '../docker-host';
import type { WrapperConfig } from '../types';
import { ENCLAVE_MCP_CONTROL_NETWORK } from './network';
import {
  agentTool,
  ENCLAVE_MCP_OPERATION_TIMEOUT_SECONDS,
  expectedRoutedTools,
  expectedTools,
  resolveEnclaveGatewayContract,
  scriptTool,
} from './gateway-contract';
import { canonicalJson, canonicalToolSet } from './gateway-transport';
import { inspectGateway } from './gateway-network';
import { proveGatewayReadiness, remainingRequestBudget } from './gateway-readiness-proof';

export {
  ENCLAVE_MCP_CAPABILITY_ENV,
  ENCLAVE_MCP_GATEWAY_CONTAINER_ENV,
  ENCLAVE_MCP_GATEWAY_ENDPOINT_ENV,
  ENCLAVE_MCP_GATEWAY_IDENTITY_ENV,
  ENCLAVE_MCP_READINESS_TIMEOUT_ENV,
  ENCLAVE_MCP_GATEWAY_RUN_LABEL,
  ENCLAVE_MCP_SERVER_NAME,
  ENCLAVE_MCP_UPSTREAM_URL,
  buildEnclaveMcpgUpstreamContract,
  resolveEnclaveGatewayContract,
  type EnclaveMcpgUpstreamContract,
} from './gateway-contract';
export { connectEnclaveGateway } from './gateway-network';
export { assertEnclaveGatewayReady } from './gateway-readiness-proof';

export async function shutdownEnclaveGateway(
  config: WrapperConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!config.enclaves?.enabled || config.keepContainers) return;
  const contract = resolveEnclaveGatewayContract(config, env);
  const drainTimeoutSeconds = ENCLAVE_MCP_OPERATION_TIMEOUT_SECONDS;
  const stopResult = await execa(
    'docker',
    ['compose', 'stop', '-t', String(drainTimeoutSeconds), 'enclave-mcp-server'],
    {
      cwd: config.workDir,
      env: getLocalDockerEnv(),
      reject: false,
      timeout: (drainTimeoutSeconds + 15) * 1_000,
    },
  );
  if (stopResult.exitCode !== 0) {
    throw new Error('Failed to drain the enclave MCP server before audit preservation');
  }
  const inspectResult = await execa(
    'docker',
    [
      'inspect',
      '--format={{.State.ExitCode}}|{{.State.OOMKilled}}|{{.State.Error}}',
      ENCLAVE_MCP_SERVER_CONTAINER_NAME,
    ],
    { env: getLocalDockerEnv(), reject: false, timeout: 10_000 },
  );
  const state = inspectResult.stdout.trim();
  if (inspectResult.exitCode !== 0 || !state.startsWith('0|false|')) {
    const match = /^(\d{1,3})\|(true|false)\|/.exec(state);
    const safeState = match && Number(match[1]) <= 255
      ? `${Number(match[1])}|${match[2]}|[error text withheld]` : 'unavailable';
    throw new Error(
      `Enclave MCP server did not complete graceful cleanup (state: ${safeState}); see retained enclave startup diagnostics`,
    );
  }
  await execa(
    'docker',
    ['network', 'disconnect', '-f', ENCLAVE_MCP_CONTROL_NETWORK, contract.containerName],
    { env: getLocalDockerEnv(), reject: false, timeout: 10_000 },
  );
}

export const enclaveGatewayTestHelpers = {
  agentTool,
  canonicalJson,
  canonicalToolSet,
  expectedRoutedTools,
  expectedTools,
  inspectGateway,
  proveGatewayReadiness,
  remainingRequestBudget,
  scriptTool,
};
