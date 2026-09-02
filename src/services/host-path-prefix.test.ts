import { applyHostPathPrefixToVolumes, prefixHostPath } from './host-path-prefix';

describe('prefixHostPath', () => {
  it('prepends the normalized prefix to an absolute path', () => {
    expect(prefixHostPath('/tmp/awf-12345', '/host')).toBe('/host/tmp/awf-12345');
  });

  it('matches the source rewrite applied to a mount derived from the same path', () => {
    // A caller comparing a bare path (e.g. workDir) against an already
    // host-path-prefixed mount source must apply the exact same rewrite, or
    // the comparison silently stops matching once a prefix is set.
    const workDir = '/tmp/awf-12345';
    const mount = `${workDir}-chroot-home:/host/home/runner:rw`;
    const [translatedMount] = applyHostPathPrefixToVolumes([mount], '/host');
    const translatedSource = translatedMount.split(':')[0];
    expect(translatedSource.startsWith(prefixHostPath(workDir, '/host'))).toBe(true);
  });

  it('leaves relative paths untouched', () => {
    expect(prefixHostPath('relative/path', '/host')).toBe('relative/path');
  });

  it('is a no-op when the prefix is "/"', () => {
    expect(prefixHostPath('/home/runner', '/')).toBe('/home/runner');
  });

  it('leaves a path already under the prefix untouched', () => {
    expect(prefixHostPath('/host/home/runner', '/host')).toBe('/host/home/runner');
    expect(prefixHostPath('/host', '/host')).toBe('/host');
  });

  it('re-prefixes an already-prefixed path when translateAlreadyPrefixedPaths is set', () => {
    expect(prefixHostPath('/host/home/runner', '/host', { translateAlreadyPrefixedPaths: true }))
      .toBe('/host/host/home/runner');
  });

  it('maps the bare root to the prefix itself', () => {
    expect(prefixHostPath('/', '/host')).toBe('/host');
  });
});

describe('applyHostPathPrefixToVolumes', () => {
  it('returns volumes unchanged when prefix is undefined', () => {
    const volumes = ['/src:/dst:ro', '/data:/data'];
    expect(applyHostPathPrefixToVolumes(volumes, undefined)).toEqual(volumes);
  });

  it('returns volumes unchanged when prefix is an empty string', () => {
    const volumes = ['/src:/dst'];
    expect(applyHostPathPrefixToVolumes(volumes, '')).toEqual(volumes);
  });

  it('returns volumes unchanged when prefix normalises to empty', () => {
    const volumes = ['/src:/dst'];
    expect(applyHostPathPrefixToVolumes(volumes, '   ')).toEqual(volumes);
  });

  it('prepends prefix to a simple absolute path', () => {
    const result = applyHostPathPrefixToVolumes(['/workspace:/workspace:rw'], '/host');
    expect(result).toEqual(['/host/workspace:/workspace:rw']);
  });

  it('prepends prefix to path without mode', () => {
    const result = applyHostPathPrefixToVolumes(['/data:/data'], '/runner');
    expect(result).toEqual(['/runner/data:/data']);
  });

  it('strips trailing slashes from prefix', () => {
    const result = applyHostPathPrefixToVolumes(['/workspace:/workspace'], '/host///');
    expect(result).toEqual(['/host/workspace:/workspace']);
  });

  it('adds leading slash to prefix if missing', () => {
    const result = applyHostPathPrefixToVolumes(['/data:/data'], 'host');
    expect(result).toEqual(['/host/data:/data']);
  });

  it('does not double-prefix if path already starts with prefix', () => {
    const result = applyHostPathPrefixToVolumes(['/host/data:/data'], '/host');
    expect(result).toEqual(['/host/data:/data']);
  });

  it('translates already-prefixed runner paths when explicitly requested', () => {
    const result = applyHostPathPrefixToVolumes(
      ['/tmp/gh-aw:/tmp/gh-aw:rw'],
      '/tmp/gh-aw',
      { translateAlreadyPrefixedPaths: true },
    );
    expect(result).toEqual(['/tmp/gh-aw/tmp/gh-aw:/tmp/gh-aw:rw']);
  });

  it('does not prefix /dev/null (security: credential hiding overlay)', () => {
    const result = applyHostPathPrefixToVolumes(['/dev/null:/secret/path:ro'], '/host');
    expect(result).toEqual(['/dev/null:/secret/path:ro']);
  });

  it('does not prefix paths starting with /dev', () => {
    const result = applyHostPathPrefixToVolumes(['/dev/shm:/dev/shm'], '/host');
    expect(result).toEqual(['/dev/shm:/dev/shm']);
  });

  it('does not prefix paths starting with /sys', () => {
    const result = applyHostPathPrefixToVolumes(['/sys/fs/cgroup:/sys/fs/cgroup:ro'], '/host');
    expect(result).toEqual(['/sys/fs/cgroup:/sys/fs/cgroup:ro']);
  });

  it('does not prefix paths starting with /proc', () => {
    const result = applyHostPathPrefixToVolumes(['/proc:/proc:ro'], '/host');
    expect(result).toEqual(['/proc:/proc:ro']);
  });

  it('does not prefix /etc/passwd when prefix starts with /tmp', () => {
    const result = applyHostPathPrefixToVolumes(['/etc/passwd:/etc/passwd:ro'], '/tmp/runner');
    expect(result).toEqual(['/etc/passwd:/etc/passwd:ro']);
  });

  it('does not prefix /etc/group when prefix starts with /tmp', () => {
    const result = applyHostPathPrefixToVolumes(['/etc/group:/etc/group:ro'], '/tmp');
    expect(result).toEqual(['/etc/group:/etc/group:ro']);
  });

  it('does prefix /etc/passwd with a non-/tmp prefix', () => {
    const result = applyHostPathPrefixToVolumes(['/etc/passwd:/etc/passwd:ro'], '/host');
    expect(result).toEqual(['/host/etc/passwd:/etc/passwd:ro']);
  });

  it('returns volumes unchanged when prefix is /', () => {
    const volumes = ['/src:/dst', '/data:/data:ro'];
    expect(applyHostPathPrefixToVolumes(volumes, '/')).toEqual(volumes);
  });

  it('handles the root source path / correctly', () => {
    const result = applyHostPathPrefixToVolumes(['/:/:ro'], '/host');
    expect(result).toEqual(['/host:/:ro']);
  });

  it('processes multiple volumes in the list', () => {
    const result = applyHostPathPrefixToVolumes(
      ['/workspace:/workspace', '/tmp:/tmp:rw', '/dev/null:/secret:ro'],
      '/host'
    );
    expect(result).toEqual([
      '/host/workspace:/workspace',
      '/host/tmp:/tmp:rw',
      '/dev/null:/secret:ro',
    ]);
  });

  it('preserves malformed mounts (fewer than 2 parts) unchanged', () => {
    const result = applyHostPathPrefixToVolumes(['no-colon'], '/host');
    expect(result).toEqual(['no-colon']);
  });

  it('does not prefix relative source paths', () => {
    const result = applyHostPathPrefixToVolumes(['relative:/cnt:ro'], '/host');
    expect(result).toEqual(['relative:/cnt:ro']);
  });
});
