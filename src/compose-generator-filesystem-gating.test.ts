import { generateDockerCompose } from './compose-generator';
import { WrapperConfig } from './types';
import { baseConfig, mockNetworkConfig } from './test-helpers/docker-test-fixtures.test-utils';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// This mock must remain per-file because jest.mock() is hoisted before imports.
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());

let mockConfig: WrapperConfig;

describe('generateDockerCompose (filesystem write gating)', () => {
  beforeEach(() => {
    mockConfig = { ...baseConfig, workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'awf-test-')) };
  });

  afterEach(() => {
    fs.rmSync(mockConfig.workDir, { recursive: true, force: true });
  });

    // Regression: `filesystem.allowWrite` is expressed in guest-visible paths,
    // and each runtime realises those paths differently. Compose generation
    // still builds an agent service object for microVM runtimes (so infra
    // containers can wire depends_on edges) even though it is omitted from the
    // emitted file, so an ungated policy was evaluated against compose bind
    // mounts the agent never uses. A Cloud Hypervisor guest path such as
    // `/workspace/allowed` is not backed by any host bind mount, so it threw
    // during writeConfigs() -- long before the Cloud Hypervisor planner ran.
    describe('filesystem.allowWrite runtime gating', () => {
      it('does not apply the compose write policy to Cloud Hypervisor guest paths', () => {
        const microVmConfig = {
          ...mockConfig,
          containerRuntime: 'cloud-hypervisor',
          filesystemAllowWrite: ['/workspace/allowed', '/tmp/gh-aw/agent'],
        };

        expect(() => generateDockerCompose(microVmConfig, mockNetworkConfig)).not.toThrow();

        // The agent itself is launched by the microVM backend, not compose.
        const policed = generateDockerCompose(microVmConfig, mockNetworkConfig);
        expect(policed.services.agent).toBeUndefined();

        // Every volume compose *does* emit must be byte-identical to the same
        // run with no policy at all: the policy belongs to the Cloud Hypervisor
        // mount tree, so it must not rewrite a single compose mode here.
        const allVolumes = (compose: ReturnType<typeof generateDockerCompose>): string[] =>
          Object.entries(compose.services)
            .flatMap(([name, service]: [string, any]) =>
              ((service.volumes ?? []) as string[]).map((volume) => `${name} ${volume}`))
            .sort();
        const unpoliced = generateDockerCompose(
          { ...mockConfig, containerRuntime: 'cloud-hypervisor' },
          mockNetworkConfig,
        );
        expect(allVolumes(policed)).toEqual(allVolumes(unpoliced));
      });

      it('still enforces the compose write policy for Docker and gVisor', () => {
        for (const containerRuntime of [undefined, 'docker', 'gvisor']) {
          const composeConfig = {
            ...mockConfig,
            ...(containerRuntime ? { containerRuntime } : {}),
            filesystemAllowWrite: [],
          };
          const volumes = generateDockerCompose(composeConfig, mockNetworkConfig)
            .services.agent.volumes as string[];

          // An empty allowlist narrows every non-internal writable bind mount.
          expect(volumes).toContain('/tmp:/tmp:ro');
          expect(volumes).not.toContain('/tmp:/tmp:rw');

          // And a guest path with no backing writable host mount still fails
          // closed for compose runtimes rather than being silently ignored.
          expect(() => generateDockerCompose(
            { ...composeConfig, filesystemAllowWrite: ['/workspace/allowed'] },
            mockNetworkConfig,
          )).toThrow(/filesystem\.allowWrite/);
        }
      });
    });
});
