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
    // Only the exact /tmp shape is structurally shared: AWF's own workDir then
    // sits under the prefix and its binds are never translated, so the daemon
    // has to resolve them to the same bytes.
    it.each(['/tmp', '/tmp/', ' /tmp ', 'tmp'])(
      'keeps a source under %p runner-resolvable',
      (prefix) => {
        const resolve = createLocalSourceResolver(new Map(), prefix);

        expect(resolve('/tmp/awf-run/init-signal')).toBe('/tmp/awf-run/init-signal');
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
    // A /tmp *descendant* is daemon-only, not shared. `/tmp/gh-aw` is one of
    // dind-probe's CANDIDATE_PREFIXES, and that loop is reached only after the
    // probe confirms the daemon cannot see the runner's filesystem — it means
    // the daemon sees runner path X at /tmp/gh-aw/X. buildCustomVolumeMounts
    // agrees, translating sources that already start with /tmp/gh-aw.
    it.each([
      ['/tmp/gh-aw', '/tmp/gh-aw/awf-docker-host-stage/bin/copilot'],
      ['/tmp/gh-aw/', '/tmp/gh-aw/tmp/awf-1730000000/init-signal'],
      ['/tmp/shared', '/tmp/shared/awf-run/init-signal'],
      ['/tmp/gh-aw/nested', '/tmp/gh-aw/nested/anything'],
    ])('fails closed for the /tmp descendant %p', (prefix, source) => {
      const resolve = createLocalSourceResolver(new Map(), prefix);

      expect(resolve(source)).toBeUndefined();
    });

    it('still resolves a plain /tmp path under a /tmp descendant prefix', () => {
      const resolve = createLocalSourceResolver(new Map(), '/tmp/gh-aw');

      // Not under the prefix, so it is an ordinary runner path that
      // translation will rewrite later.
      expect(resolve('/tmp/awf-1730000000/init-signal')).toBe('/tmp/awf-1730000000/init-signal');
    });

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

  // `/` normalises to `/`, which translateBindMountHostPath returns unchanged —
  // it prefixes nothing. Reading it as a daemon root would make every absolute
  // source unattributable and fail an otherwise ordinary run closed.
  it.each(['/', '//', ' / '])('treats %p as no prefix at all', (prefix) => {
    const resolve = createLocalSourceResolver(new Map(), prefix);

    expect(resolve(workDirSource)).toBe(workDirSource);
    expect(resolve('/home/runner/work/repo/repo')).toBe('/home/runner/work/repo/repo');
  });
});
