import { createLocalSourceResolver } from './mount-topology';

/**
 * Pure string-level coverage of local-source resolution.
 *
 * The filesystem-backed suites cannot pin this down on their own: they build a
 * prefix from `os.tmpdir()`, which is `/tmp/...` on Linux CI but
 * `/private/var/...` on macOS after `realpathSync`. That makes "is this prefix
 * shared?" answer differently per platform, so a Linux-only regression can hide
 * behind a green local run. These cases hardcode both shapes instead.
 */
describe('createLocalSourceResolver', () => {
  const workDirSource = '/tmp/awf-1730000000/init-signal';

  describe('shared prefix (/tmp)', () => {
    // /tmp-rooted prefixes are the ARC/DinD shared-volume shape: the same path
    // is valid on the runner and in the daemon. AWF stages files there with
    // local fs calls, and prefix translation leaves such a source unrewritten.
    it.each(['/tmp', '/tmp/', '/tmp/shared', 'tmp'])(
      'keeps a source under %p runner-resolvable',
      (prefix) => {
        const resolve = createLocalSourceResolver(new Map(), prefix);

        expect(resolve('/tmp/shared/awf-run/init-signal')).toBe('/tmp/shared/awf-run/init-signal');
      },
    );

    it('resolves the run workDir that sits inside the prefix', () => {
      const resolve = createLocalSourceResolver(new Map(), '/tmp');

      // Returning undefined here made the whole run directory unclassifiable:
      // every nested bind under a policy-narrowed read-only cover then failed
      // closed before launch.
      expect(resolve(workDirSource)).toBe(workDirSource);
      expect(resolve('/tmp/awf-1730000000-chroot-home')).toBe('/tmp/awf-1730000000-chroot-home');
    });
  });

  describe('daemon-only prefix', () => {
    it.each(['/host', '/dind', '/var/runner'])(
      'refuses to attribute a source already under %p',
      (prefix) => {
        const resolve = createLocalSourceResolver(new Map(), prefix);

        expect(resolve(`${prefix}/tmp/awf-run/init-signal`)).toBeUndefined();
      },
    );

    it.each(['/host/', ' /host ', 'host'])(
      'fails closed for %p, which the CLI only trims',
      (prefix) => {
        // The raw value reaches the resolver, so an unnormalised comparison
        // would miss and hand back a daemon path as if it were runner-local.
        const resolve = createLocalSourceResolver(new Map(), prefix);

        expect(resolve('/host/data/inner')).toBeUndefined();
      },
    );

    it('still resolves a runner path that merely resembles the prefix', () => {
      const resolve = createLocalSourceResolver(new Map(), '/host');

      // Sibling, not nested: `/hostage` must not be mistaken for `/host/...`.
      expect(resolve('/hostage/thing')).toBe('/hostage/thing');
      // The prefix itself is not "under" the prefix.
      expect(resolve('/host')).toBe('/host');
    });
  });

  describe('custom mounts', () => {
    it('maps a daemon-side custom source back to its runner path', () => {
      const resolve = createLocalSourceResolver(new Map([['/host/data', '/data']]), '/host');

      expect(resolve('/host/data/inner')).toBe('/data/inner');
    });

    it('fails closed when a custom source cannot be mapped back', () => {
      const resolve = createLocalSourceResolver(new Map([['/host/data', '']]), '/host');

      expect(resolve('/host/data/inner')).toBeUndefined();
    });

    it('applies the custom mapping even under a shared prefix', () => {
      // Custom mounts are resolved before any prefix reasoning, so a shared
      // prefix must not quietly bypass their fail-closed mapping.
      const resolve = createLocalSourceResolver(new Map([['/tmp/data', '']]), '/tmp');

      expect(resolve('/tmp/data/inner')).toBeUndefined();
    });
  });

  it('resolves to itself when no prefix is configured', () => {
    const resolve = createLocalSourceResolver(new Map());

    expect(resolve(workDirSource)).toBe(workDirSource);
  });
});
