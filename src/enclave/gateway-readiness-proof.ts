import type { WrapperConfig } from '../types';
import {
  updateEnclaveStartupProgress,
  type EnclaveStartupStage,
} from './startup-progress';
import { HostPreflightReporter } from '../cloud-hypervisor/host-preflight-progress';
import {
  expectedRoutedTools,
  MCP_PROTOCOL_VERSION,
  REQUEST_TIMEOUT_MS,
  RETRY_DELAY_MS,
  resolveEnclaveGatewayContract,
  type EnclaveGatewayContract,
} from './gateway-contract';
import { canonicalToolSet, GatewayReadinessError, postJsonRpc } from './gateway-transport';

export function remainingRequestBudget(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new GatewayReadinessError('Gateway readiness deadline expired', false, 'readiness-deadline');
  }
  return Math.min(REQUEST_TIMEOUT_MS, remaining);
}

export async function proveGatewayReadiness(
  contract: EnclaveGatewayContract,
  deadline: number,
  onRequest?: (stage: EnclaveStartupStage) => void,
  report = new HostPreflightReporter('gateway-handshake'),
): Promise<void> {
  const sessionId = await report.check('initialize', async () => {
    const initializeBudget = remainingRequestBudget(deadline);
    onRequest?.('initialize');
    const initialized = await postJsonRpc(contract.endpoint, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'awf-readiness', version: '1.0.0' },
      },
    }, initializeBudget, contract.gatewayApiKey);
    const result = initialized.response.result as { serverInfo?: { name?: string } } | undefined;
    if (initialized.response.error || result?.serverInfo?.name !== 'awmg-awf-enclave') {
      throw new GatewayReadinessError(
        'Gateway initialize proof did not reach the routed AWF enclave server', false,
        initialized.response.error ? 'rpc-error'
          : result?.serverInfo?.name === undefined ? 'malformed-protocol' : 'identity-mismatch',
      );
    }
    return initialized.sessionId;
  });
  await report.check('initialized', async () => {
    const initializedBudget = remainingRequestBudget(deadline);
    onRequest?.('initialized');
    await postJsonRpc(contract.endpoint, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }, initializedBudget, contract.gatewayApiKey, sessionId);
  });
  await report.check('tools-list', async () => {
    const listBudget = remainingRequestBudget(deadline);
    onRequest?.('tools-list');
    const listed = await postJsonRpc(contract.endpoint, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    }, listBudget, contract.gatewayApiKey, sessionId);
    const tools = (listed.response.result as { tools?: unknown })?.tools;
    if (canonicalToolSet(tools) !== canonicalToolSet(expectedRoutedTools(contract.expectedTools))) {
      throw new GatewayReadinessError(
        'Gateway enclave tool contract did not exactly match the enabled executors', false,
        listed.response.error ? 'rpc-error' : 'tools-mismatch',
      );
    }
  });
}

export async function assertEnclaveGatewayReady(
  config: WrapperConfig,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs?: number,
): Promise<void> {
  updateEnclaveStartupProgress(config, { stage: 'gateway-contract' });
  const report = new HostPreflightReporter('gateway-handshake', (hostPreflight) =>
    updateEnclaveStartupProgress(config, { hostPreflight }));
  const contract = await report.check('contract', () => resolveEnclaveGatewayContract(config, env));
  const deadline = Date.now() + (timeoutMs ?? contract.readinessTimeoutMs);
  let lastError: unknown;
  let attempts = 0;
  do {
    try {
      await proveGatewayReadiness(contract, deadline, (stage) => {
        if (stage === 'initialize') attempts += 1;
        updateEnclaveStartupProgress(config, {
          stage, readiness: 'attempted', code: 'none', httpStatus: null,
          attempts: Math.min(attempts, 1200),
        });
      }, report);
      updateEnclaveStartupProgress(config, { readiness: 'ready', code: 'ready' });
      return;
    } catch (error) {
      updateEnclaveStartupProgress(config, {
        code: error instanceof GatewayReadinessError ? error.code : 'unknown',
        httpStatus: error instanceof GatewayReadinessError ? error.httpStatus : null,
      });
      if (!(error instanceof GatewayReadinessError) || !error.retryable) {
        throw error;
      }
      lastError = error;
      const remaining = deadline - Date.now();
      if (remaining > 0) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(RETRY_DELAY_MS, remaining)));
      }
    }
  } while (Date.now() < deadline);
  updateEnclaveStartupProgress(config, { code: 'readiness-deadline' });
  throw new Error(
    `Enclave MCP gateway readiness timed out before primary-agent startup: ${lastError instanceof Error ? lastError.message : 'unknown readiness failure'
    }`,
  );
}
