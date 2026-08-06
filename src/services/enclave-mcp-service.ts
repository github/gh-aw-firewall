import { buildRuntimeImageRef } from '../image-tag';
import { getSafeHostGid, getSafeHostUid } from '../host-identity';
import type { WrapperConfig } from '../types';
import {
  ENCLAVE_BROKER_AUDIT_DIR,
  ENCLAVE_BROKER_CAPABILITY_PATH,
  ENCLAVE_BROKER_CONTROL_DIR,
  ENCLAVE_BROKER_DOCKER_SOCKET_PATH,
  ENCLAVE_BROKER_SEED_MAP_PATH,
  ENCLAVE_BROKER_SEEDS_DIR,
  ENCLAVE_BROKER_SOCKET_DIR,
  ENCLAVE_BROKER_WORK_DIR,
  resolveEnclavePaths,
} from '../enclave/paths';
import { resolveBoundedQueryPrimaryBackend } from '../bounded-query/runtime-matrix';
import { resolveDockerSocketPath } from './agent-volumes/docker-socket';
import { applyHostPathPrefixToVolumes } from './host-path-prefix';
import { buildContainerSecurityHardening } from './service-security';
import type { ImageBuildConfig } from './squid-service';

const LOCAL_ENCLAVE_SCRIPT_IMAGE = 'awf-enclave-script:local';
const LOCAL_ENCLAVE_MCP_SERVER_IMAGE = 'awf-enclave-mcp-server:local';
const ENCLAVE_SCRIPT_IMAGE_NAME = 'enclave-script';
const ENCLAVE_MCP_SERVER_IMAGE_NAME = 'enclave-mcp-server';

interface EnclaveMcpServiceParams {
  config: WrapperConfig;
  imageConfig: ImageBuildConfig;
}

export interface EnclaveMcpBuildResult {
  scriptImageService: Record<string, unknown>;
  service: Record<string, unknown>;
}

function resolveImages(imageConfig: ImageBuildConfig, scriptImageOverride?: string): {
  scriptImageRef: string;
  scriptSource: Record<string, unknown>;
  serverSource: Record<string, unknown>;
} {
  if (imageConfig.useGHCR) {
    const scriptImageRef = scriptImageOverride ?? buildRuntimeImageRef(
      imageConfig.registry,
      ENCLAVE_SCRIPT_IMAGE_NAME,
      imageConfig.parsedTag,
    );
    return {
      scriptImageRef,
      scriptSource: { image: scriptImageRef },
      serverSource: {
        image: buildRuntimeImageRef(
          imageConfig.registry,
          ENCLAVE_MCP_SERVER_IMAGE_NAME,
          imageConfig.parsedTag,
        ),
      },
    };
  }
  const build = {
    context: `${imageConfig.projectRoot}/containers/bounded-query`,
    dockerfile: 'Dockerfile',
  };
  if (scriptImageOverride) {
    return {
      scriptImageRef: scriptImageOverride,
      scriptSource: { image: scriptImageOverride },
      serverSource: {
        image: LOCAL_ENCLAVE_MCP_SERVER_IMAGE,
        build: { ...build, target: 'enclave-mcp-server' },
      },
    };
  }
  return {
    scriptImageRef: LOCAL_ENCLAVE_SCRIPT_IMAGE,
    scriptSource: { image: LOCAL_ENCLAVE_SCRIPT_IMAGE, build: { ...build, target: 'query' } },
    serverSource: {
      image: LOCAL_ENCLAVE_MCP_SERVER_IMAGE,
      build: { ...build, target: 'enclave-mcp-server' },
    },
  };
}

function toDaemonVisiblePath(hostPath: string, prefix: string | undefined): string {
  const [translated] = applyHostPathPrefixToVolumes([`${hostPath}:${hostPath}`], prefix);
  return translated.split(':')[0];
}

export function buildEnclaveMcpService(params: EnclaveMcpServiceParams): EnclaveMcpBuildResult {
  const { config, imageConfig } = params;
  const script = config.enclaves?.executors.script;
  if (!config.enclaves?.enabled || !script?.enabled) {
    throw new Error('buildEnclaveMcpService: enclaves script executor must be enabled');
  }
  if (script.runtime === 'sbx') {
    throw new Error('buildEnclaveMcpService: sbx script enclave capability is not yet available');
  }
  const paths = resolveEnclavePaths(config.workDir);
  const images = resolveImages(imageConfig, script.image);
  const dockerSocketPath = resolveDockerSocketPath(config);
  const scriptImageService: Record<string, unknown> = {
    ...images.scriptSource,
    network_mode: 'none',
    entrypoint: ['/bin/true'],
    ...buildContainerSecurityHardening({ memLimit: '32m', pidsLimit: 16, cpuShares: 64 }),
    restart: 'no',
  };
  const service: Record<string, unknown> = {
    container_name: 'awf-enclave-mcp-server',
    ...images.serverSource,
    network_mode: 'none',
    volumes: applyHostPathPrefixToVolumes(
      [
        `${paths.seedsDir}:${ENCLAVE_BROKER_SEEDS_DIR}:ro`,
        `${paths.workDir}:${ENCLAVE_BROKER_WORK_DIR}:rw`,
        `${paths.runDir}:${ENCLAVE_BROKER_SOCKET_DIR}:rw`,
        `${paths.controlDir}:${ENCLAVE_BROKER_CONTROL_DIR}:rw`,
        `${paths.auditDir}:${ENCLAVE_BROKER_AUDIT_DIR}:rw`,
        `${paths.seedMapPath}:${ENCLAVE_BROKER_SEED_MAP_PATH}:ro`,
        `${dockerSocketPath}:${ENCLAVE_BROKER_DOCKER_SOCKET_PATH}:rw`,
      ],
      config.dockerHostPathPrefix,
    ),
    environment: {
      AWF_ENCLAVE_IMAGE: images.scriptImageRef,
      AWF_ENCLAVE_BACKEND: script.runtime,
      AWF_ENCLAVE_PRIMARY_BACKEND: resolveBoundedQueryPrimaryBackend(config.containerRuntime),
      AWF_ENCLAVE_TIMEOUT: String(script.timeout),
      AWF_ENCLAVE_MEMORY: script.memoryLimit,
      AWF_ENCLAVE_CPU: script.cpuLimit,
      AWF_ENCLAVE_PIDS: String(script.pidsLimit),
      AWF_ENCLAVE_TMPFS: script.tmpfsLimit,
      AWF_ENCLAVE_MAX_OUTPUT_BYTES: String(script.maxOutputBytes),
      AWF_ENCLAVE_MAX_SCRIPT_BYTES: String(script.maxScriptBytes),
      AWF_ENCLAVE_MAX_INVOCATIONS: String(script.maxInvocations),
      AWF_ENCLAVE_HOST_WORK_DIR: toDaemonVisiblePath(paths.workDir, config.dockerHostPathPrefix),
      AWF_ENCLAVE_SOCKET_UID: getSafeHostUid(),
      AWF_ENCLAVE_SOCKET_GID: getSafeHostGid(),
      AWF_ENCLAVE_CAPABILITY_PATH: ENCLAVE_BROKER_CAPABILITY_PATH,
    },
    depends_on: {
      'enclave-script-image': { condition: 'service_completed_successfully' },
    },
    healthcheck: {
      test: ['CMD', 'node', '/opt/awf/enclave-mcp/healthcheck.js'],
      interval: '5s',
      timeout: '3s',
      retries: 10,
      start_period: '20s',
    },
    ...buildContainerSecurityHardening({ memLimit: '256m', pidsLimit: 100, cpuShares: 256 }),
    cap_add: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER'],
    restart: 'no',
    stop_grace_period: '5s',
  };
  return { scriptImageService, service };
}

export const enclaveMcpServiceTestHelpers = {
  ENCLAVE_SCRIPT_IMAGE_NAME,
  ENCLAVE_MCP_SERVER_IMAGE_NAME,
  LOCAL_ENCLAVE_SCRIPT_IMAGE,
  LOCAL_ENCLAVE_MCP_SERVER_IMAGE,
  resolveImages,
  toDaemonVisiblePath,
};
