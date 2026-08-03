import * as fs from 'fs';
import execa from 'execa';
import { BOUNDED_QUERY_BROKER_CONTAINER_NAME } from '../constants';
import { getLocalDockerEnv } from '../host-env';
import { resolveDockerHostGateway } from '../services/host-gateway';
import type { WrapperConfig } from '../types';
import { resolveBoundedQueryPaths } from './paths';

export const BOUNDED_QUERY_TCP_PORT = 18080;
export const BOUNDED_QUERY_INGRESS_NETWORK = 'awf-bounded-query-ingress';
export const SBX_HOST_ALIAS = 'host.docker.internal';

interface SbxIngressCapabilities {
  version: 1;
  query: string;
  probe: string;
}

export interface ResolvedSbxIngress {
  endpoint: string;
  queryCapability: string;
  probeCapability: string;
  skillPath: string;
  wrapperDir: string;
}

function readCapabilities(config: WrapperConfig): SbxIngressCapabilities {
  const paths = resolveBoundedQueryPaths(config.workDir);
  const parsed = JSON.parse(fs.readFileSync(paths.capabilityPath, 'utf8')) as Partial<SbxIngressCapabilities>;
  const capabilityPattern = /^[0-9a-f]{64}$/;
  if (
    parsed.version !== 1
    || typeof parsed.query !== 'string'
    || typeof parsed.probe !== 'string'
    || !capabilityPattern.test(parsed.query)
    || !capabilityPattern.test(parsed.probe)
    || parsed.query === parsed.probe
  ) {
    throw new Error('Bounded-query sbx ingress capability file is malformed');
  }
  return parsed as SbxIngressCapabilities;
}

/** Resolves the healthy host-gateway publication without logging capabilities. */
export async function resolveSbxIngress(config: WrapperConfig): Promise<ResolvedSbxIngress> {
  if (config.boundedQueryIngressTransport !== 'sbx-http') {
    throw new Error('resolveSbxIngress called for a non-HTTP bounded-query transport');
  }
  const expectedHostIp = resolveDockerHostGateway();
  if (!expectedHostIp) {
    throw new Error('Could not resolve the Docker host-gateway IP for bounded-query sbx ingress');
  }

  const deadline = Date.now() + 30_000;
  let lastPublished = '';
  let lastHealth = '';
  while (Date.now() < deadline) {
    const result = await execa(
      'docker',
      [
        'inspect',
        '--format',
        `{{if .State.Health}}{{.State.Health.Status}}{{end}}|{{with index (index .NetworkSettings.Ports "${BOUNDED_QUERY_TCP_PORT}/tcp") 0}}{{.HostIp}}:{{.HostPort}}{{end}}`,
        BOUNDED_QUERY_BROKER_CONTAINER_NAME,
      ],
      {
        env: getLocalDockerEnv(),
        reject: false,
        timeout: 5_000,
      },
    );
    const [health = '', published = ''] = result.stdout.trim().split('|', 2);
    lastHealth = health;
    lastPublished = published;
    const separator = published.lastIndexOf(':');
    const publishedHostIp = separator === -1 ? '' : published.slice(0, separator);
    const publishedPort = separator === -1 ? '' : published.slice(separator + 1);
    const publishedPortNumber = Number(publishedPort);
    const hasValidPort = /^[1-9][0-9]{0,4}$/.test(publishedPort) && publishedPortNumber <= 65535;
    if (result.exitCode === 0 && health === 'healthy' && publishedHostIp === expectedHostIp && hasValidPort) {
      const paths = resolveBoundedQueryPaths(config.workDir);
      const capabilities = readCapabilities(config);
      return {
        endpoint: `http://${SBX_HOST_ALIAS}:${publishedPort}/query`,
        queryCapability: capabilities.query,
        probeCapability: capabilities.probe,
        skillPath: paths.skillPath,
        wrapperDir: paths.agentDir,
      };
    }
    if (result.exitCode === 0 && health === 'healthy') {
      throw new Error(`Bounded-query sbx ingress is not narrowly published on host-gateway ${expectedHostIp}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(
    `Bounded-query sbx ingress did not become healthy on host-gateway ${expectedHostIp} ` +
    `(health=${lastHealth || 'unknown'}, published=${lastPublished || 'none'})`,
  );
}

/** Deletes the on-disk secret after the running broker has loaded it. */
export function removeSbxIngressCapabilityFile(config: WrapperConfig): void {
  fs.rmSync(resolveBoundedQueryPaths(config.workDir).capabilityPath, { force: true });
}

/** @internal */
// ts-prune-ignore-next
export const ingressTestHelpers = { readCapabilities };
