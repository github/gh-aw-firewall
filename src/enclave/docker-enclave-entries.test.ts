import * as path from 'path';
import type { WrapperConfig } from '../types';
import { normalizeEnclavesConfig } from '../parsers/enclave-parser';
import { parseImageTag } from '../image-tag';
import { deriveDockerEnclaveRunnerConfig } from '../services/enclave-mcp-service';
import { deriveDockerEnclaveEntries } from './docker-enclave-entries';

jest.mock('../services/enclave-mcp-service', () => ({
  deriveDockerEnclaveRunnerConfig: jest.fn((_config, _imageConfig, kind) => ({ executorKind: kind })),
}));

describe('Docker enclave entry derivation', () => {
  const config = {
    workDir: '/tmp/awf-entry-test',
    enclaves: normalizeEnclavesConfig([
      { script: {}, tmpfsLimit: '32m', repos: [{ repo: 'octo/private', sensitivity: 'internal' }] },
      { agent: { model: 'trusted-model' }, tmpfsLimit: '64m' },
    ]),
  } as WrapperConfig;

  beforeEach(() => { jest.clearAllMocks(); });

  it('preserves executor order, runner configuration, and writable budgets', () => {
    expect(deriveDockerEnclaveEntries(config)).toEqual([
      {
        entryId: 'script', executorKind: 'script', config: { executorKind: 'script' },
        hostWritableBytes: 32 * 1024 ** 2, aggregateWritableBytes: 160 * 1024 ** 2,
      },
      {
        entryId: 'agent', executorKind: 'agent', config: { executorKind: 'agent' },
        hostWritableBytes: 64 * 1024 ** 2, aggregateWritableBytes: 192 * 1024 ** 2,
      },
    ]);
  });

  it('skips disabled executors without deriving their runners', () => {
    const disabled = structuredClone(config);
    disabled.enclaves!.executors.script.enabled = false;
    expect(deriveDockerEnclaveEntries(disabled).map(entry => entry.entryId)).toEqual(['agent']);
    expect(deriveDockerEnclaveRunnerConfig).toHaveBeenCalledTimes(1);
    expect(deriveDockerEnclaveRunnerConfig).toHaveBeenCalledWith(disabled, expect.any(Object), 'agent');
  });

  it.each([false, true])('preserves image resolution and project root (buildLocal=%s)', buildLocal => {
    const custom = { ...config, buildLocal, imageRegistry: 'ghcr.io/example/awf', imageTag: 'v1.2.3' };
    deriveDockerEnclaveEntries(custom);
    const imageConfig = jest.mocked(deriveDockerEnclaveRunnerConfig).mock.calls[0][1];
    expect(imageConfig).toMatchObject({
      useGHCR: !buildLocal, registry: custom.imageRegistry, parsedTag: parseImageTag(custom.imageTag),
      projectRoot: path.join(__dirname, '..', '..'),
    });
    expect(imageConfig.resolveImage!('enclave-agent')).toBe('ghcr.io/example/awf/enclave-agent:v1.2.3');
  });
});
