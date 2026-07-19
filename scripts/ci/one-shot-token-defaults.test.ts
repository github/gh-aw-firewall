import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

const repoRoot = path.resolve(__dirname, '../..');
const sourcePath = path.join(repoRoot, 'containers/agent/one-shot-token/one-shot-token.c');
const encodeScriptPath = path.join(repoRoot, 'containers/agent/one-shot-token/encode-tokens.sh');
const generatedDefaultsBlockRegex = /\/\* --- BEGIN GENERATED OBFUSCATED DEFAULTS[\s\S]*?\/\* --- END GENERATED OBFUSCATED DEFAULTS --- \*\//;

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, '\n').trim();
}

describe('one-shot token default fallback', () => {
  it('keeps the generated C fallback defaults in sync with encode-tokens.sh', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');
    const sourceDefaultsBlock = source.match(generatedDefaultsBlockRegex)?.[0];

    expect(sourceDefaultsBlock).toBeDefined();

    const generatedDefaultsBlock = execFileSync('bash', [encodeScriptPath], {
      cwd: repoRoot,
      encoding: 'utf-8',
    });

    expect(normalizeLineEndings(sourceDefaultsBlock ?? ''))
      .toBe(normalizeLineEndings(generatedDefaultsBlock));
  });
});
