import * as fs from 'fs';
import execa from 'execa';
import {
  ENCLAVE_AGENT_CLI_PROXY_CONTAINER_NAME,
} from '../constants';
import { getLocalDockerEnv } from '../docker-host';
import type { WrapperConfig } from '../types';
import {
  ENCLAVE_GITHUB_CONTROL_NETWORK,
  ENCLAVE_GITHUB_CONTROL_SUBNET,
  ENCLAVE_GITHUB_PROXY_ALIAS,
  ENCLAVE_GITHUB_PROXY_PORT,
} from './network';

export const ENCLAVE_GITHUB_PROXY_CONTAINER_ENV = 'AWF_ENCLAVE_GITHUB_PROXY_CONTAINER';
export const ENCLAVE_GITHUB_PROXY_IDENTITY_ENV = 'AWF_ENCLAVE_GITHUB_PROXY_IDENTITY';
export const ENCLAVE_GITHUB_PROXY_CA_CERT_ENV = 'AWF_ENCLAVE_GITHUB_PROXY_CA_CERT';
export const ENCLAVE_GITHUB_PROXY_RUN_LABEL = 'com.github.gh-aw.enclave-github.run';

interface EnclaveGithubGatewayContract {
  containerName: string;
  identity: string;
  caCertPath: string;
}

function isEnclaveGithubEnabled(config: WrapperConfig): boolean {
  return config.enclaves?.enabled === true
    && config.enclaves.executors.agent.enabled
    && config.enclaves.executors.agent.github?.cli === 'issues-read-v1';
}

function requiredIdentity(name: string, value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9_.-]{7,127}$/.test(value)) {
    throw new Error(`${name} is missing or invalid`);
  }
  return value;
}

export function resolveEnclaveGithubGatewayContract(
  config: WrapperConfig,
  env: NodeJS.ProcessEnv = process.env,
): EnclaveGithubGatewayContract {
  if (!isEnclaveGithubEnabled(config)) {
    throw new Error('Enclave GitHub gateway contract requested while issues-read-v1 is disabled');
  }
  const containerName = requiredIdentity(
    ENCLAVE_GITHUB_PROXY_CONTAINER_ENV,
    env[ENCLAVE_GITHUB_PROXY_CONTAINER_ENV],
  );
  const identity = env[ENCLAVE_GITHUB_PROXY_IDENTITY_ENV] ?? '';
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(identity)) {
    throw new Error(
      `${ENCLAVE_GITHUB_PROXY_IDENTITY_ENV} must be the canonical compiler capability run identity`,
    );
  }
  const caCertPath = env[ENCLAVE_GITHUB_PROXY_CA_CERT_ENV] ?? '';
  if (!caCertPath.startsWith('/')) {
    throw new Error(`${ENCLAVE_GITHUB_PROXY_CA_CERT_ENV} must be an absolute path`);
  }
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(caCertPath);
  } catch {
    throw new Error(`${ENCLAVE_GITHUB_PROXY_CA_CERT_ENV} is unavailable`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${ENCLAVE_GITHUB_PROXY_CA_CERT_ENV} must be a regular non-symlink file`);
  }
  return { containerName, identity, caCertPath };
}

async function inspectExternalProxy(contract: EnclaveGithubGatewayContract): Promise<void> {
  const result = await execa(
    'docker',
    ['inspect', '--format', '{{json .}}', contract.containerName],
    { env: getLocalDockerEnv(), reject: false, timeout: 10_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error('Trusted enclave GitHub proxy container is unavailable');
  }
  let inspected: {
    Name?: string;
    State?: { Running?: boolean };
    Config?: { Labels?: Record<string, string> };
    HostConfig?: { NetworkMode?: string };
  };
  try {
    inspected = JSON.parse(result.stdout);
  } catch {
    throw new Error('Trusted enclave GitHub proxy identity could not be inspected');
  }
  if (
    inspected.Name !== `/${contract.containerName}`
    || inspected.State?.Running !== true
    || inspected.Config?.Labels?.[ENCLAVE_GITHUB_PROXY_RUN_LABEL] !== contract.identity
    || inspected.HostConfig?.NetworkMode !== 'bridge'
  ) {
    throw new Error('Trusted enclave GitHub proxy identity did not match the compiler handoff');
  }
}

async function assertControlNetworkMembership(
  contract: EnclaveGithubGatewayContract,
): Promise<void> {
  const result = await execa(
    'docker',
    ['network', 'inspect', '--format', '{{json .}}', ENCLAVE_GITHUB_CONTROL_NETWORK],
    { env: getLocalDockerEnv(), reject: false, timeout: 10_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error('Enclave GitHub control network is unavailable');
  }
  let network: {
    Internal?: boolean;
    Driver?: string;
    IPAM?: { Config?: Array<{ Subnet?: string }> };
    Containers?: Record<string, { Name?: string }>;
  };
  try {
    network = JSON.parse(result.stdout);
  } catch {
    throw new Error('Enclave GitHub control network membership could not be inspected');
  }
  const subnetConfig = network.IPAM?.Config ?? [];
  if (
    network.Internal !== true
    || network.Driver !== 'bridge'
    || subnetConfig.length !== 1
    || subnetConfig[0]?.Subnet !== ENCLAVE_GITHUB_CONTROL_SUBNET
  ) {
    throw new Error('Enclave GitHub control network is not the fixed isolated bridge');
  }
  const containers = network.Containers ?? {};
  const names = Object.values(containers).map((entry) => entry.Name).filter(Boolean).sort();
  const expected = [ENCLAVE_AGENT_CLI_PROXY_CONTAINER_NAME, contract.containerName].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error('Enclave GitHub control network contains an unexpected member');
  }
}

async function assertExternalProxyAlias(
  contract: EnclaveGithubGatewayContract,
): Promise<void> {
  const result = await execa(
    'docker',
    ['inspect', '--format', '{{json .}}', contract.containerName],
    { env: getLocalDockerEnv(), reject: false, timeout: 10_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error('Trusted enclave GitHub proxy network attachment is unavailable');
  }
  let inspected: {
    NetworkSettings?: {
      Networks?: Record<string, { Aliases?: string[] | null }>;
    };
  };
  try {
    inspected = JSON.parse(result.stdout);
  } catch {
    throw new Error('Trusted enclave GitHub proxy network attachment could not be inspected');
  }
  const aliases = inspected.NetworkSettings?.Networks?.[ENCLAVE_GITHUB_CONTROL_NETWORK]?.Aliases;
  if (!Array.isArray(aliases) || !aliases.includes(ENCLAVE_GITHUB_PROXY_ALIAS)) {
    throw new Error('Trusted enclave GitHub proxy is missing its fixed private alias');
  }
}

export async function connectEnclaveGithubGateway(
  config: WrapperConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!isEnclaveGithubEnabled(config)) return;
  const contract = resolveEnclaveGithubGatewayContract(config, env);
  await inspectExternalProxy(contract);
  const result = await execa(
    'docker',
    [
      'network',
      'connect',
      '--alias',
      ENCLAVE_GITHUB_PROXY_ALIAS,
      ENCLAVE_GITHUB_CONTROL_NETWORK,
      contract.containerName,
    ],
    { env: getLocalDockerEnv(), reject: false, timeout: 10_000 },
  );
  if (
    result.exitCode !== 0
    && !/already exists in network|is already attached|already connected/i.test(result.stderr || '')
  ) {
    throw new Error('Failed to attach the trusted enclave GitHub proxy to its private control network');
  }
  await assertControlNetworkMembership(contract);
  await assertExternalProxyAlias(contract);
}

export async function assertEnclaveGithubGatewayReady(config: WrapperConfig): Promise<void> {
  if (!isEnclaveGithubEnabled(config)) return;
  const contract = resolveEnclaveGithubGatewayContract(config);
  await assertControlNetworkMembership(contract);
  const result = await execa(
    'docker',
    [
      'inspect',
      '--format',
      '{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}',
      ENCLAVE_AGENT_CLI_PROXY_CONTAINER_NAME,
    ],
    { env: getLocalDockerEnv(), reject: false, timeout: 10_000 },
  );
  if (result.exitCode !== 0 || result.stdout.trim() !== 'true|healthy') {
    throw new Error('Enclave GitHub CLI proxy did not prove the issues-read-v1 route ready');
  }
  const upstream = await execa(
    'docker',
    [
      'exec',
      ENCLAVE_AGENT_CLI_PROXY_CONTAINER_NAME,
      'curl',
      '--silent',
      '--show-error',
      '--output',
      '/dev/null',
      '--cacert',
      '/tmp/proxy-tls/ca.crt',
      `https://${ENCLAVE_GITHUB_PROXY_ALIAS}:${ENCLAVE_GITHUB_PROXY_PORT}/`,
    ],
    { env: getLocalDockerEnv(), reject: false, timeout: 10_000 },
  );
  if (upstream.exitCode !== 0) {
    throw new Error('Enclave GitHub CLI proxy could not establish the fixed TLS route to mcpg');
  }
}

export async function disconnectEnclaveGithubGateway(
  config: WrapperConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!isEnclaveGithubEnabled(config) || config.keepContainers) return;
  const contract = resolveEnclaveGithubGatewayContract(config, env);
  const result = await execa(
    'docker',
    ['network', 'disconnect', '-f', ENCLAVE_GITHUB_CONTROL_NETWORK, contract.containerName],
    { env: getLocalDockerEnv(), reject: false, timeout: 10_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error('Failed to disconnect the trusted enclave GitHub proxy');
  }
}

export async function shutdownEnclaveGithubCliProxy(config: WrapperConfig): Promise<void> {
  if (!isEnclaveGithubEnabled(config) || config.keepContainers) return;
  const result = await execa(
    'docker',
    ['stop', '--time', '5', ENCLAVE_AGENT_CLI_PROXY_CONTAINER_NAME],
    { env: getLocalDockerEnv(), reject: false, timeout: 15_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error('Failed to stop the enclave GitHub CLI proxy before audit preservation');
  }
}

export const enclaveGithubGatewayTestHelpers = {
  assertControlNetworkMembership,
  assertExternalProxyAlias,
  inspectExternalProxy,
};
