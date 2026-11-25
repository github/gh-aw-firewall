import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

type Percentages = {
  lines: number;
  statements: number;
  functions: number;
  branches: number;
};

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-coverage-comparison-'));
const prPath = path.join(directory, 'pr.json');
const basePath = path.join(directory, 'base.json');
const script = path.join(__dirname, 'compare-coverage.ts');

function summary(percentages: Percentages) {
  const metric = (pct: number) => ({
    total: 10000,
    covered: Math.round(pct * 100),
    skipped: 0,
    pct,
  });
  const coverage = {
    lines: metric(percentages.lines),
    statements: metric(percentages.statements),
    functions: metric(percentages.functions),
    branches: metric(percentages.branches),
  };
  return { total: coverage, '/workspace/src/example.ts': coverage };
}

function compare(base: Percentages, pr: Percentages) {
  fs.writeFileSync(basePath, JSON.stringify(summary(base)));
  fs.writeFileSync(prPath, JSON.stringify(summary(pr)));
  return spawnSync(process.execPath, [require.resolve('tsx/cli'), script, prPath, basePath], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_ENV: '', GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '' },
  });
}

afterAll(() => {
  fs.rmSync(basePath, { force: true });
  fs.rmSync(prPath, { force: true });
  fs.rmdirSync(directory);
});

describe('coverage comparison tolerance', () => {
  const base = { lines: 94.94, statements: 93.65, functions: 94.04, branches: 88.21 };

  it('accepts a one-hundredth-point decrease without reporting a file change', () => {
    const result = compare(base, {
      lines: 94.93,
      statements: 93.64,
      functions: 94.04,
      branches: 88.20,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('| Statements | 93.65% | 93.64% | ➡️ -0.01% |');
    expect(result.stdout).not.toContain('Per-file Coverage Changes');
  });

  it('treats a one-hundredth-point increase consistently', () => {
    const result = compare({ ...base, statements: 93.64 }, base);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('| Statements | 93.64% | 93.65% | ➡️ +0.01% |');
    expect(result.stdout).not.toContain('Per-file Coverage Changes');
  });

  it.each([93.63, 93.6399])('rejects a decrease beyond the tolerance (PR %s)', statements => {
    const result = compare(base, { ...base, statements });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Coverage Regression Detected');
  });
});
