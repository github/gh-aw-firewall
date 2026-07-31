import * as fs from 'fs';
import execa from 'execa';
import { BOUNDED_QUERY_BROKER_CONTAINER_NAME } from '../constants';
import { getLocalDockerEnv } from '../host-env';
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

/** Resolves the loopback-only ephemeral host port without logging capabilities. */
export async function resolveSbxIngress(config: WrapperConfig): Promise<ResolvedSbxIngress> {
  if (config.boundedQueryIngressTransport !== 'sbx-http') {
    throw new Error('resolveSbxIngress called for a non-HTTP bounded-query transport');
  }
  const result = await execa(
    'docker',
    [
      'inspect',
      '--format',
      `{{(index (index .NetworkSettings.Ports "${BOUNDED_QUERY_TCP_PORT}/tcp") 0).HostIp}}:{{(index (index .NetworkSettings.Ports "${BOUNDED_QUERY_TCP_PORT}/tcp") 0).HostPort}}`,
      BOUNDED_QUERY_BROKER_CONTAINER_NAME,
    ],
    {
      env: getLocalDockerEnv(),
      reject: false,
      timeout: 30_000,
    },
  );
  const published = result.stdout.trim();
  const match = /^127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(published);
  if (result.exitCode !== 0 || !match || Number(match[1]) > 65535) {
    throw new Error('Bounded-query sbx ingress is not narrowly published on host loopback');
  }

  const paths = resolveBoundedQueryPaths(config.workDir);
  const capabilities = readCapabilities(config);
  return {
    endpoint: `http://${SBX_HOST_ALIAS}:${match[1]}/query`,
    queryCapability: capabilities.query,
    probeCapability: capabilities.probe,
    skillPath: paths.skillPath,
    wrapperDir: paths.agentDir,
  };
}

/** Deletes the on-disk secret after the running broker has loaded it. */
export function removeSbxIngressCapabilityFile(config: WrapperConfig): void {
  fs.rmSync(resolveBoundedQueryPaths(config.workDir).capabilityPath, { force: true });
}

/** @internal */
// ts-prune-ignore-next
export const ingressTestHelpers = { readCapabilities };
