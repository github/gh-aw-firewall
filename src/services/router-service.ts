import { ROUTER_CONTAINER_NAME } from '../constants';
import { assignImageSource } from '../image-tag';
import { buildContainerSecurityHardening } from './service-security';
import { ImageBuildConfig } from './squid-service';

export const ROUTING_NETWORK_NAME = 'awf-routing';
export const ROUTER_SERVICE_NAME = 'router';
export const ROUTER_DNS_NAME = 'gh-aw-router';
const ROUTER_PORT = 8737;

interface RouterServiceParams {
  imageConfig: ImageBuildConfig;
}

export function buildRouterService({ imageConfig }: RouterServiceParams): any {
  const { useGHCR, registry, parsedTag, projectRoot, resolveImage } = imageConfig;
  const service: any = {
    container_name: ROUTER_CONTAINER_NAME,
    networks: {
      [ROUTING_NETWORK_NAME]: {
        aliases: [ROUTER_DNS_NAME],
      },
    },
    healthcheck: {
      test: ['CMD', 'curl', '-fsS', `http://localhost:${ROUTER_PORT}/healthz`],
      interval: '2s',
      timeout: '3s',
      retries: 15,
      start_period: '10s',
    },
    ...buildContainerSecurityHardening({ memLimit: '512m', pidsLimit: 100, cpuShares: 512 }),
    stop_grace_period: '2s',
  };

  assignImageSource(service, {
    useGHCR,
    registry,
    imageName: 'router',
    parsedTag,
    projectRoot,
    containerDir: 'router',
  });
  if (useGHCR && resolveImage) service.image = resolveImage('router');

  return service;
}
