#!/usr/bin/env npx tsx
/**
 * Compare coverage between PR and base branch
 *
 * This script compares coverage-summary.json files from the PR and base branch
 * to detect coverage regressions and generate a detailed report.
 *
 * Usage:
 *   npx tsx scripts/ci/compare-coverage.ts <pr-coverage.json> <base-coverage.json>
 *
 * Exit codes:
 *   0 - Coverage maintained or improved
 *   1 - Coverage decreased (regression detected)
 */

import * as fs from 'fs';

// Allow for subtraction error when comparing percentages in the 0-100 range.
const COVERAGE_TOLERANCE = 0.01 + 100 * Number.EPSILON;

interface CoverageMetric {
  total: number;
  covered: number;
  skipped: number;
  pct: number;
}

interface FileCoverage {
  lines: CoverageMetric;
  statements: CoverageMetric;
  functions: CoverageMetric;
  branches: CoverageMetric;
}

interface CoverageSummary {
  total: FileCoverage;
  [filePath: string]: FileCoverage;
}

interface CoverageChange {
  file: string;
  linesBefore: number;
  linesAfter: number;
  linesDelta: number;
  statementsBefore: number;
  statementsAfter: number;
  statementsDelta: number;
}

interface ComparisonResult {
  overallRegression: boolean;
  linesDelta: number;
  statementsDelta: number;
  functionsDelta: number;
  branchesDelta: number;
  fileChanges: CoverageChange[];
  newFiles: string[];
  removedFiles: string[];
}

function loadCoverageSummary(filePath: string): CoverageSummary | null {
  if (!fs.existsSync(filePath)) {
    console.error(`Coverage file not found: ${filePath}`);
    return null;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as CoverageSummary;
  } catch (error) {
    console.error(`Failed to parse coverage file: ${filePath}`, error);
    return null;
  }
}

function compareCoverage(
  prCoverage: CoverageSummary,
  baseCoverage: CoverageSummary
): ComparisonResult {
  const prTotal = prCoverage.total;
  const baseTotal = baseCoverage.total;

  // Calculate overall deltas
  const linesDelta = prTotal.lines.pct - baseTotal.lines.pct;
  const statementsDelta = prTotal.statements.pct - baseTotal.statements.pct;
  const functionsDelta = prTotal.functions.pct - baseTotal.functions.pct;
  const branchesDelta = prTotal.branches.pct - baseTotal.branches.pct;

  // Check for regression beyond the comparison tolerance.
  const overallRegression =
    linesDelta < -COVERAGE_TOLERANCE ||
    statementsDelta < -COVERAGE_TOLERANCE ||
    functionsDelta < -COVERAGE_TOLERANCE ||
    branchesDelta < -COVERAGE_TOLERANCE;

  // Get file lists
  const prFiles = new Set(Object.keys(prCoverage).filter((f) => f !== 'total'));
  const baseFiles = new Set(Object.keys(baseCoverage).filter((f) => f !== 'total'));

  // Find new, removed, and changed files
  const newFiles: string[] = [];
  const removedFiles: string[] = [];
  const fileChanges: CoverageChange[] = [];

  for (const file of prFiles) {
    if (!baseFiles.has(file)) {
      newFiles.push(file);
    } else {
      const prFile = prCoverage[file];
      const baseFile = baseCoverage[file];

      const linesDiff = prFile.lines.pct - baseFile.lines.pct;
      const statementsDiff = prFile.statements.pct - baseFile.statements.pct;

      // Only include files with significant changes
      if (Math.abs(linesDiff) > COVERAGE_TOLERANCE || Math.abs(statementsDiff) > COVERAGE_TOLERANCE) {
        fileChanges.push({
          file,
          linesBefore: baseFile.lines.pct,
          linesAfter: prFile.lines.pct,
          linesDelta: linesDiff,
          statementsBefore: baseFile.statements.pct,
          statementsAfter: prFile.statements.pct,
          statementsDelta: statementsDiff,
        });
      }
    }
  }

  for (const file of baseFiles) {
    if (!prFiles.has(file)) {
      removedFiles.push(file);
    }
  }

  // Sort file changes by delta (largest decreases first)
  fileChanges.sort((a, b) => a.linesDelta - b.linesDelta);

  return {
    overallRegression,
    linesDelta,
    statementsDelta,
    functionsDelta,
    branchesDelta,
    fileChanges,
    newFiles,
    removedFiles,
  };
}

function formatDelta(delta: number): string {
  const sign = delta >= 0 ? '+' : '';
  return `${sign}${delta.toFixed(2)}%`;
}

function formatDeltaEmoji(delta: number): string {
  if (delta > COVERAGE_TOLERANCE) return '📈';
  if (delta < -COVERAGE_TOLERANCE) return '📉';
  return '➡️';
}

function generateMarkdownReport(
  prCoverage: CoverageSummary,
  baseCoverage: CoverageSummary,
  result: ComparisonResult
): string {
  const prTotal = prCoverage.total;
  const baseTotal = baseCoverage.total;

  let report = '';

  // Status header
  if (result.overallRegression) {
    report += `## ⚠️ Coverage Regression Detected\n\n`;
    report += `This PR decreases test coverage. Please add tests to maintain coverage levels.\n\n`;
  } else {
    report += `## ✅ Coverage Check Passed\n\n`;
  }

  // Overall coverage comparison
  report += `### Overall Coverage\n\n`;
  report += `| Metric | Base | PR | Delta |\n`;
  report += `|--------|------|-----|-------|\n`;
  report += `| Lines | ${baseTotal.lines.pct.toFixed(2)}% | ${prTotal.lines.pct.toFixed(2)}% | ${formatDeltaEmoji(result.linesDelta)} ${formatDelta(result.linesDelta)} |\n`;
  report += `| Statements | ${baseTotal.statements.pct.toFixed(2)}% | ${prTotal.statements.pct.toFixed(2)}% | ${formatDeltaEmoji(result.statementsDelta)} ${formatDelta(result.statementsDelta)} |\n`;
  report += `| Functions | ${baseTotal.functions.pct.toFixed(2)}% | ${prTotal.functions.pct.toFixed(2)}% | ${formatDeltaEmoji(result.functionsDelta)} ${formatDelta(result.functionsDelta)} |\n`;
  report += `| Branches | ${baseTotal.branches.pct.toFixed(2)}% | ${prTotal.branches.pct.toFixed(2)}% | ${formatDeltaEmoji(result.branchesDelta)} ${formatDelta(result.branchesDelta)} |\n`;
  report += `\n`;

  // Per-file changes
  if (result.fileChanges.length > 0) {
    report += `<details>\n`;
    report += `<summary>📁 Per-file Coverage Changes (${result.fileChanges.length} files)</summary>\n\n`;
    report += `| File | Lines (Before → After) | Statements (Before → After) |\n`;
    report += `|------|------------------------|-----------------------------|\n`;

    for (const change of result.fileChanges) {
      // Simplify file path for display
      const displayPath = change.file.replace(/^.*\/src\//, 'src/');
      const linesChange = `${change.linesBefore.toFixed(1)}% → ${change.linesAfter.toFixed(1)}% (${formatDelta(change.linesDelta)})`;
      const stmtsChange = `${change.statementsBefore.toFixed(1)}% → ${change.statementsAfter.toFixed(1)}% (${formatDelta(change.statementsDelta)})`;
      report += `| \`${displayPath}\` | ${linesChange} | ${stmtsChange} |\n`;
    }

    report += `\n</details>\n\n`;
  }

  // New files
  if (result.newFiles.length > 0) {
    report += `<details>\n`;
    report += `<summary>✨ New Files (${result.newFiles.length} files)</summary>\n\n`;

    for (const file of result.newFiles) {
      const displayPath = file.replace(/^.*\/src\//, 'src/');
      const coverage = prCoverage[file];
      report += `- \`${displayPath}\`: ${coverage.lines.pct.toFixed(1)}% lines\n`;
    }

    report += `\n</details>\n\n`;
  }

  // Removed files
  if (result.removedFiles.length > 0) {
    report += `<details>\n`;
    report += `<summary>🗑️ Removed Files (${result.removedFiles.length} files)</summary>\n\n`;

    for (const file of result.removedFiles) {
      const displayPath = file.replace(/^.*\/src\//, 'src/');
      report += `- \`${displayPath}\`\n`;
    }

    report += `\n</details>\n\n`;
  }

  report += `---\n`;
  report += `*Coverage comparison generated by \`scripts/ci/compare-coverage.ts\`*\n`;

  return report;
}

function main(): void {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error('Usage: compare-coverage.ts <pr-coverage.json> <base-coverage.json>');
    console.error('');
    console.error('Arguments:');
    console.error('  pr-coverage.json   Path to coverage-summary.json from the PR');
    console.error('  base-coverage.json Path to coverage-summary.json from the base branch');
    process.exit(1);
  }

  const prCoveragePath = args[0];
  const baseCoveragePath = args[1];

  // Load coverage files
  const prCoverage = loadCoverageSummary(prCoveragePath);
  const baseCoverage = loadCoverageSummary(baseCoveragePath);

  if (!prCoverage || !baseCoverage) {
    console.error('Failed to load coverage files');
    process.exit(1);
  }

  // Compare coverage
  const result = compareCoverage(prCoverage, baseCoverage);

  // Generate report
  const report = generateMarkdownReport(prCoverage, baseCoverage, result);

  // Output to GITHUB_STEP_SUMMARY if available
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    fs.appendFileSync(summaryPath, report);
    console.log('Coverage comparison summary written to GITHUB_STEP_SUMMARY');
  }

  // Also output report to stdout for logs
  console.log('\n' + report);

  // Output key metrics as GitHub Actions outputs
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) {
    fs.appendFileSync(
      outputPath,
      `regression=${result.overallRegression}\n` +
        `lines_delta=${result.linesDelta.toFixed(2)}\n` +
        `statements_delta=${result.statementsDelta.toFixed(2)}\n` +
        `functions_delta=${result.functionsDelta.toFixed(2)}\n` +
        `branches_delta=${result.branchesDelta.toFixed(2)}\n`
    );
  }

  // Output the report as an environment variable for PR comment
  const envPath = process.env.GITHUB_ENV;
  if (envPath) {
    fs.appendFileSync(envPath, `COVERAGE_REPORT<<EOF\n${report}EOF\n`);
  }

  // Exit with error if regression detected
  if (result.overallRegression) {
    console.error('\n❌ Coverage regression detected! PR decreases overall coverage.');
    process.exit(1);
  } else {
    console.log('\n✅ Coverage check passed. No regression detected.');
    process.exit(0);
  }
}

main();
