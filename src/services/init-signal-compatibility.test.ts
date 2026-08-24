import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
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
      // Escaped `\${...}` so this stays a literal shell expansion rather than a
      // JavaScript one: the assertion is a byte-for-byte excerpt of the script.
      expect(entrypointSource).toContain(
        `while [ ! -f "\${INIT_SIGNAL_DIR}/ready" ] && [ ! -f "\${LEGACY_INIT_SIGNAL_DIR}/ready" ]; do`,
      );
    });
  });

  describe('new CLI + old agent image: the init container runs the old script', () => {
    /**
     * The audit step of `setup-iptables.sh` as shipped in agent images released
     * before the signal directory moved to /run. Two properties matter and both
     * are load-bearing: the script runs under `set -e`, and the audit file path
     * is hardcoded to the legacy directory rather than read from
     * `$AWF_INIT_SIGNAL_DIR`. A redirection into a missing directory is a
     * command failure, so `set -e` aborts the script before the CLI's
     * `&& touch "$AWF_INIT_SIGNAL_DIR/ready"` ever runs, and the agent then
     * waits out its full ready timeout.
     */
    const OLD_AUDIT_STEP = [
      'set -e',
      `audit_file="${LEGACY_INIT_SIGNAL_DIR}/iptables-audit.txt"`,
      'echo "# iptables audit dump" > "$audit_file"',
      'echo "## IPv4 NAT rules" >> "$audit_file"',
      'echo OLD_SCRIPT_COMPLETED',
    ].join('\n');

    /**
     * Materialises the init container's filesystem view: every bind target in
     * the generated service exists as a directory, and nothing else does.
     */
    function stageInitContainerRootfs(volumes: string[]): string {
      const rootfs = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-initns-'));
      for (const spec of volumes) {
        const target = spec.split(':')[1];
        if (target) fs.mkdirSync(path.join(rootfs, target), { recursive: true });
      }
      return rootfs;
    }

    function runOldSetupScript(rootfs: string): { stdout: string; readyExists: boolean } {
      const script = [
        `cd "${rootfs}"`,
        // Rebase the container-absolute paths onto the staged rootfs.
        OLD_AUDIT_STEP.replace(
          `audit_file="${LEGACY_INIT_SIGNAL_DIR}`,
          `audit_file="${rootfs}${LEGACY_INIT_SIGNAL_DIR}`,
        ),
        // Exactly how the CLI chains the ready signal after the script.
        `touch "${rootfs}${INIT_SIGNAL_DIR}/ready"`,
      ].join('\n');

      let stdout = '';
      try {
        stdout = execFileSync('/bin/sh', ['-c', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        stdout = String((err as { stdout?: string }).stdout ?? '');
      }
      return {
        stdout,
        readyExists: fs.existsSync(path.join(rootfs, INIT_SIGNAL_DIR.slice(1), 'ready')),
      };
    }

    it('lets the old audit dump succeed so the ready signal is still written', () => {
      const volumes = generateDockerCompose(getConfig(), mockNetworkConfig)
        .services['iptables-init'].volumes as string[];
      const rootfs = stageInitContainerRootfs(volumes);

      try {
        const result = runOldSetupScript(rootfs);

        expect(result.stdout).toContain('OLD_SCRIPT_COMPLETED');
        expect(result.readyExists).toBe(true);
      } finally {
        fs.rmSync(rootfs, { recursive: true, force: true });
      }
    });

    it('proves the test would catch the regression it is guarding', () => {
      // Same script, but with only the current signal directory mounted: this is
      // the state that stranded an older image, and it must be detectable.
      const rootfs = stageInitContainerRootfs([`/src:${INIT_SIGNAL_DIR}:rw`]);

      try {
        const result = runOldSetupScript(rootfs);

        expect(result.stdout).not.toContain('OLD_SCRIPT_COMPLETED');
        expect(result.readyExists).toBe(false);
      } finally {
        fs.rmSync(rootfs, { recursive: true, force: true });
      }
    });

    it('mounts the legacy path writable, because the old script writes there', () => {
      const volumes = generateDockerCompose(getConfig(), mockNetworkConfig)
        .services['iptables-init'].volumes as string[];

      expect(volumes).toContain(`${getConfig().workDir}/init-signal:${LEGACY_INIT_SIGNAL_DIR}:rw`);
      expect(volumes).toContain(`${getConfig().workDir}/init-signal:${INIT_SIGNAL_DIR}:rw`);
    });

    it('keeps both init-signal views on one source, so either path signals the agent', () => {
      const volumes = (generateDockerCompose(getConfig(), mockNetworkConfig)
        .services['iptables-init'].volumes as string[])
        .filter((spec) => spec.includes('init-signal'))
        .map((spec) => spec.split(':')[0]);

      expect(new Set(volumes).size).toBe(1);
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
