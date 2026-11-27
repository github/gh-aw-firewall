import * as path from 'path';
import type { WrapperConfig } from '../types';
import { parseImageTag } from '../image-tag';
import { resolveRuntimeImage } from '../image-resolver';
import { deriveDockerEnclaveRunnerConfig } from '../services/enclave-mcp-service';
import type { DockerHostExecutorEntry } from './docker-host-executor';
import { dockerMemoryBytes, dockerWritableBudget } from './docker-host-storage';

export function deriveDockerEnclaveEntries(config: WrapperConfig): DockerHostExecutorEntry[] {
  const registry = config.imageRegistry || 'ghcr.io/github/gh-aw-firewall';
  const parsedTag = parseImageTag(config.imageTag || 'latest');
  const imageConfig = {
    useGHCR: !config.buildLocal,
    registry,
    parsedTag,
    projectRoot: path.join(__dirname, '..', '..'),
    resolveImage: (name: import('../image-resolver').RuntimeImageName) =>
      resolveRuntimeImage(config, name, registry, parsedTag),
  };
  return Object.entries(config.enclaves!.executors)
    .filter(([, entry]) => entry.enabled)
    .map(([kind, entry]) => {
      const executorKind = kind as 'script' | 'agent';
      const runner = deriveDockerEnclaveRunnerConfig(config, imageConfig, executorKind);
      const hostWritableBytes = dockerMemoryBytes(entry.tmpfsLimit);
      const { containerBytes } = dockerWritableBudget(
        executorKind, entry.tmpfsLimit, hostWritableBytes, Number.MAX_SAFE_INTEGER,
      );
      return {
        entryId: kind, executorKind, config: runner,
        hostWritableBytes, aggregateWritableBytes: hostWritableBytes + containerBytes,
      };
    });
}
