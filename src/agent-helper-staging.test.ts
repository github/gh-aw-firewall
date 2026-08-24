import * as fs from 'fs';
import * as path from 'path';

const entrypointSource = fs.readFileSync(
  path.resolve(__dirname, '../containers/agent/entrypoint.sh'),
  'utf8',
);

/**
 * AWF stages several helpers on the host side of the chroot before the agent
 * runs: the one-shot-token LD_PRELOAD library, the gh CLI proxy wrapper, the
 * Claude key helper and CA bundles.
 *
 * These used to live under `/tmp/awf-lib`. That is a bind mount of the host's
 * `/tmp`, so `filesystem.allowWrite` can narrow it to read-only, at which point
 * every one of those copies fails. The failures were swallowed, silently
 * disabling security controls while the run appeared healthy.
 *
 * They now stage under `/run/awf-lib`, which lives on the container's own
 * writable rootfs and is therefore never affected by a user write policy.
 */
describe('agent helper staging location', () => {
  it('never stages helpers under the host-bound /tmp', () => {
    expect(entrypointSource).not.toContain('/tmp/awf-lib');
  });

  it('stages helpers under /run/awf-lib on both sides of the chroot', () => {
    expect(entrypointSource).toContain('mkdir -p /host/run/awf-lib');
    expect(entrypointSource).toContain('/host/run/awf-lib/one-shot-token.so');
    expect(entrypointSource).toContain('/host/run/awf-lib/gh');
  });

  it('preloads the one-shot token library from the chroot-visible path', () => {
    expect(entrypointSource).toContain('LD_PRELOAD=/run/awf-lib/one-shot-token.so');
  });

  it('puts the staging directory on PATH so the gh wrapper shadows the host gh', () => {
    expect(entrypointSource).toContain('export AWF_HOST_PATH="/run/awf-lib:${AWF_HOST_PATH:-$PATH}"');
    expect(entrypointSource).toContain('export PATH="/run/awf-lib:${PATH}"');
  });

  it('cleans up the staging directory at its new location', () => {
    expect(entrypointSource).toContain('rm -rf /run/awf-lib');
  });

  it('no longer claims /tmp is always writable', () => {
    expect(entrypointSource).not.toContain('/tmp is mounted read-write in chroot mode');
    expect(entrypointSource).not.toMatch(/\/tmp\/awf-lib\/ \(always writable\)/);
  });

  describe('fail-closed behaviour', () => {
    function functionBody(name: string): string {
      const start = entrypointSource.indexOf(`${name}() {`);
      expect(start).toBeGreaterThan(-1);
      const end = entrypointSource.indexOf('\n}\n', start);
      return entrypointSource.slice(start, end);
    }

    it('refuses to start when the one-shot token library cannot be staged', () => {
      const body = functionBody('copy_preload_libs');

      expect(body).toContain('Refusing to start without one-shot token protection');
      // Both the mkdir and the copy failure paths must abort.
      expect(body.match(/exit 1/g) ?? []).toHaveLength(2);
      expect(body).not.toContain('Token protection will be disabled (tokens may be readable multiple times)\n      fi');
    });

    it('still tolerates a host libc that cannot load the library', () => {
      // An incompatible dynamic linker (musl/Alpine) is an environment property,
      // not a staging failure, and must stay a warning.
      const body = functionBody('copy_preload_libs');

      expect(body).toContain('host libc incompatibility');
      expect(body).toContain('Token protection will be disabled');
    });

    it('refuses to start with an unmediated gh CLI when the proxy is enabled', () => {
      const occurrences = entrypointSource.match(
        /Refusing to start with an unmediated gh CLI/g,
      ) ?? [];

      // Once for the chroot path, once for the non-chroot path.
      expect(occurrences).toHaveLength(2);
      expect(entrypointSource).not.toContain('[entrypoint][WARN] Could not install gh CLI proxy wrapper');
    });
  });
});
