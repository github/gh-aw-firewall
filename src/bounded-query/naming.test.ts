import { spawnSync } from 'child_process';

describe('bounded-query naming', () => {
  it('does not retain the previous feature name in tracked paths or text', () => {
    const oldPrefix = 'sealed';
    const oldNoun = 'probe';
    const forbiddenFragments = [
      `${oldPrefix}-${oldNoun}`,
      `${oldPrefix}_${oldNoun}`,
      `${oldPrefix} ${oldNoun}`,
      `${oldPrefix}${oldNoun}`,
      `${oldPrefix}-query`,
      `${oldPrefix}_query`,
      `${oldPrefix} query`,
    ];
    const trackedFilesResult = spawnSync('git', ['ls-files', '-z'], {
      encoding: 'utf8',
    });
    expect(trackedFilesResult.status).toBe(0);
    const trackedFiles = trackedFilesResult.stdout
      .split('\0')
      .filter(Boolean);
    const pathMatches = trackedFiles.filter((file) => {
      const normalized = file.toLowerCase();
      return forbiddenFragments.some((fragment) => normalized.includes(fragment));
    });

    const grepArgs = ['grep', '-I', '-l', '-i', '-z'];
    for (const fragment of forbiddenFragments) {
      grepArgs.push('-e', fragment);
    }
    grepArgs.push('--');
    const contentMatchesResult = spawnSync('git', grepArgs, { encoding: 'utf8' });
    expect([0, 1]).toContain(contentMatchesResult.status);
    const contentMatches = contentMatchesResult.status === 0
      ? contentMatchesResult.stdout.split('\0').filter(Boolean)
      : [];

    expect([...new Set([...pathMatches, ...contentMatches])]).toEqual([]);
  });
});
