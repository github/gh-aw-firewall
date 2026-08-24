import * as fs from 'fs';
import * as path from 'path';
import { generateDockerCompose, mockNetworkConfig, useAgentVolumesTestConfig } from './service-test-setup.test-utils';
import { INIT_SIGNAL_DIR, LEGACY_INIT_SIGNAL_DIR } from '../constants';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('../test-helpers/mock-execa.test-utils').execaMockFactory());

const { getConfig } = useAgentVolumesTestConfig();

const entrypointSource = fs.readFileSync(
  path.resolve(__dirname, '../../containers/agent/entrypoint.sh'),
  'utf8',
);

/**
 * The init-signal handshake spans two independently versioned artefacts: the
 * CLI, which decides where the ready-file is mounted, and the agent image,
 * which decides where it waits. These tests pin both directions of that
 * contract so a move like `/tmp/awf-init` -> `/run/awf-init` cannot silently
 * strand a pinned `--image-tag`.
 */
describe('init signal directory compatibility', () => {
  describe('new CLI + new agent image', () => {
    it('mounts the ready-file source at the current path, writable', () => {
      const volumes = generateDockerCompose(getConfig(), mockNetworkConfig)
        .services.agent.volumes as string[];

      expect(volumes).toContain(`${getConfig().workDir}/init-signal:${INIT_SIGNAL_DIR}:rw`);
    });

    it('waits on the current path', () => {
      expect(entrypointSource).toContain('INIT_SIGNAL_DIR="${AWF_INIT_SIGNAL_DIR:-/run/awf-init}"');
    });
  });

  describe('new CLI + old agent image', () => {
    it('also exposes the same source at the legacy path an older image polls', () => {
      const volumes = generateDockerCompose(getConfig(), mockNetworkConfig)
        .services.agent.volumes as string[];

      expect(volumes).toContain(`${getConfig().workDir}/init-signal:${LEGACY_INIT_SIGNAL_DIR}:ro`);
    });

    it('keeps the legacy view read-only, since older images only poll it', () => {
      const volumes = generateDockerCompose(getConfig(), mockNetworkConfig)
        .services.agent.volumes as string[];

      expect(volumes).not.toContain(`${getConfig().workDir}/init-signal:${LEGACY_INIT_SIGNAL_DIR}:rw`);
    });

    it('keeps the legacy path exposed when a write policy narrows /tmp', () => {
      const workspaceDir = process.env.GITHUB_WORKSPACE || process.cwd();
      const volumes = generateDockerCompose(
        { ...getConfig(), filesystemAllowWrite: [`${workspaceDir}/src`] },
        mockNetworkConfig,
      ).services.agent.volumes as string[];

      expect(volumes).toContain('/tmp:/tmp:ro');
      expect(volumes).toContain(`${getConfig().workDir}/init-signal:${LEGACY_INIT_SIGNAL_DIR}:ro`);
    });
  });

  describe('old CLI + new agent image', () => {
    it('still accepts a ready-file delivered at the legacy path', () => {
      expect(entrypointSource).toContain('LEGACY_INIT_SIGNAL_DIR="/tmp/awf-init"');
      expect(entrypointSource).toContain(
        'while [ ! -f "${INIT_SIGNAL_DIR}/ready" ] && [ ! -f "${LEGACY_INIT_SIGNAL_DIR}/ready" ]; do',
      );
    });
  });

  it('does not rely on a symlink inside the init container, which the agent cannot see', () => {
    const command = generateDockerCompose(getConfig(), mockNetworkConfig)
      .services['iptables-init'].command as string[];

    // The init container has its own rootfs and mount namespace: anything it
    // creates at the legacy path is invisible to the agent container.
    expect(command.join(' ')).not.toContain('ln -s');
    expect(command.join(' ')).not.toContain(LEGACY_INIT_SIGNAL_DIR);
  });
});
