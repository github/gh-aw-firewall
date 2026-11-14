import {
  assertCleanAbsolutePath,
  assertContainedPath,
  assertNoOverlap,
  containsOrEquals,
  containsPath,
  pathDepth,
  stagedPathFor,
} from './mount-tree-paths';

describe('mount-tree path helpers', () => {
  it.each([
    '', 'relative/path', '/', '/host/', '/host//child', '/host/./child',
    '/host/../outside', '/host/\0child', `/${'é'.repeat(2048)}`,
  ])('rejects unclean or unsafe absolute path %j', (value) => {
    expect(() => assertCleanAbsolutePath(value, 'test path')).toThrow(
      'must be an absolute clean non-root path',
    );
  });

  it('accepts clean paths, including spaces and the byte-length boundary', () => {
    expect(() => assertCleanAbsolutePath('/host/a b', 'test path')).not.toThrow();
    expect(() => assertCleanAbsolutePath(`/${'a'.repeat(4095)}`, 'test path')).not.toThrow();
  });

  it.each([
    ['/host/export/child', true],
    ['/host/export/child/nested', true],
    ['/host/export', false],
    ['/host/export-other', false],
    ['/host/export/../outside', false],
    ['/host/export/child/../../outside', false],
    ['/host', false],
    ['/elsewhere', false],
  ])('contains only strict descendants: %s', (child, expected) => {
    expect(containsPath('/host/export', child)).toBe(expected);
  });

  it('fails containment closed at the root, sibling prefix and traversal boundaries', () => {
    for (const child of ['/host/export', '/host/export-other', '/host/export/../outside']) {
      expect(() => assertContainedPath('/host/export', child, 'overlay')).toThrow(
        'must stay inside /host/export',
      );
    }
    expect(() => assertContainedPath('/host/export', '/host/export/child', 'overlay')).not.toThrow();
  });

  it('detects overlap symmetrically without confusing sibling prefixes', () => {
    expect(containsOrEquals('/root/a', '/root/a')).toBe(true);
    expect(containsOrEquals('/root/a', '/root/a/b')).toBe(true);
    expect(containsOrEquals('/root/a/b', '/root/a')).toBe(true);
    expect(containsOrEquals('/root/a', '/root/ab')).toBe(false);
    expect(() => assertNoOverlap(['/root/a'], '/root/a', 'overlay')).toThrow('Duplicate');
    expect(() => assertNoOverlap(['/root/a'], '/root/a/b', 'overlay')).toThrow('Overlapping');
    expect(() => assertNoOverlap(['/root/a/b'], '/root/a', 'mask')).toThrow('Overlapping');
    expect(() => assertNoOverlap(['/root/a'], '/root/ab', 'overlay')).not.toThrow();
  });

  it('maps a validated destination into the staged namespace and preserves depth ordering', () => {
    expect(stagedPathFor('/run/staged', '/host/export', '/host/export/a b/file'))
      .toBe('/run/staged/a b/file');
    expect(pathDepth('/run/staged/a/b')).toBeGreaterThan(pathDepth('/run/staged/a'));
  });
});
