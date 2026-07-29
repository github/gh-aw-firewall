import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

describe('bounded-query naming', () => {
  it('does not retain the previous feature name in tracked paths or text', () => {
    const repositoryRoot = path.resolve(__dirname, '..', '..');
    const oldPrefix = 'sealed';
    const oldNoun = 'probe';
    const forbidden = [
      new RegExp(`${oldPrefix}[-_ ]${oldNoun}s?`, 'i'),
      new RegExp(`${oldPrefix}${oldNoun}`, 'i'),
      new RegExp(`${oldPrefix}[-_ ]query`, 'i'),
    ];
    const trackedFiles = execFileSync('git', ['ls-files', '-z'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    })
      .split('\0')
      .filter(Boolean);
    const matches: string[] = [];

    for (const relativePath of trackedFiles) {
      if (forbidden.some((pattern) => pattern.test(relativePath))) {
        matches.push(relativePath);
        continue;
      }

      const absolutePath = path.join(repositoryRoot, relativePath);
      if (!fs.lstatSync(absolutePath).isFile()) continue;
      const contents = fs.readFileSync(absolutePath);
      if (contents.includes(0)) continue;
      const text = contents.toString('utf8');
      if (forbidden.some((pattern) => pattern.test(text))) {
        matches.push(relativePath);
      }
    }

    expect(matches).toEqual([]);
  });
});
