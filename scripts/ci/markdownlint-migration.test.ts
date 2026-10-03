import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { scripts } from '../../package.json';

const root = path.resolve(__dirname, '../..');
const cli = path.join(root, 'node_modules/markdownlint-cli/markdownlint.js');
const args = [
  '--dot', '--config', '.markdownlint.json', '**/*.md',
  '--ignore', 'node_modules', '--ignore', 'docs-site/node_modules',
  '--ignore', '.specify', '--ignore', '.claude',
];

describe('braces-free markdown lint migration', () => {
  let fixture: string;
  const invalid = '# Heading\n\n### Skipped level\n';

  beforeEach(() => {
    fixture = fs.mkdtempSync(path.join(root, '.markdownlint-migration-'));
    fs.copyFileSync(path.join(root, '.markdownlint.json'), path.join(fixture, '.markdownlint.json'));
    for (const directory of ['.github/workflows', 'node_modules', 'docs-site/node_modules', '.specify', '.claude']) {
      fs.mkdirSync(path.join(fixture, directory), { recursive: true });
    }
    fs.writeFileSync(path.join(fixture, 'README.md'), '# Heading\n');
  });

  afterEach(() => fs.rmSync(fixture, { recursive: true, force: true }));

  function lint() {
    return spawnSync(process.execPath, [cli, ...args], { cwd: fixture, encoding: 'utf8' });
  }

  it('keeps hidden workflows in scope and all existing directory exclusions', () => {
    expect(scripts['lint:md']).toBe(
      "markdownlint --dot --config .markdownlint.json '**/*.md' --ignore node_modules " +
      '--ignore docs-site/node_modules --ignore .specify --ignore .claude',
    );
    for (const directory of ['node_modules', 'docs-site/node_modules', '.specify', '.claude']) {
      fs.writeFileSync(path.join(fixture, directory, 'ignored.md'), invalid);
    }
    expect(lint().status).toBe(0);
    fs.writeFileSync(path.join(fixture, '.github/workflows/probe.md'), invalid);
    const result = lint();
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('.github/workflows/probe.md');
    expect(result.stderr).toContain('MD001');
    expect(result.stderr).not.toContain('ignored.md');
  });

  it('preserves configured rule exceptions and fails explicitly on malformed configuration', () => {
    fs.writeFileSync(path.join(fixture, 'README.md'), '# Heading\n\n' + 'long line '.repeat(30) + '\n');
    expect(lint().status).toBe(0);
    fs.writeFileSync(path.join(fixture, '.markdownlint.json'), '{invalid');
    const result = lint();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('SyntaxError:');
    expect(result.stderr).toContain('JSON');
  });

  it('retains the rule engine while removing vulnerable glob dependencies', () => {
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    expect(lock.packages['node_modules/markdownlint'].version).toBe('0.41.1');
    for (const name of ['braces', 'micromatch', 'fast-glob', 'markdownlint-cli2']) {
      expect(Object.keys(lock.packages).some((key) => key.endsWith(`/node_modules/${name}`)))
        .toBe(false);
    }
    const workflow = yaml.load(fs.readFileSync(
      path.join(root, '.github/workflows/lint.yml'), 'utf8',
    )) as { jobs: { markdownlint: { steps: Array<{ uses?: string; with?: { 'node-version'?: string } }> } } };
    expect(workflow.jobs.markdownlint.steps.find((step) => step.uses?.startsWith('actions/setup-node@'))
      ?.with?.['node-version']).toBe('22');
  });
});
