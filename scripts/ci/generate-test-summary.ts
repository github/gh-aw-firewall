#!/usr/bin/env node
/**
 * Generate GitHub Actions job summary from Jest test output
 * This script parses Jest test output and creates a markdown summary
 * showing what scenarios were tested and their results.
 */

import * as fs from 'fs';

interface TestResults {
  passed: number;
  failed: number;
  total: number;
  duration: string;
}

interface TestScenario {
  name: string;
  passed: boolean;
  isGroup?: boolean;
}

function parseTestOutput(output: string): { results: TestResults; scenarios: TestScenario[] } {
  const lines = output.split('\n');

  // Extract test results from "Tests:" line
  const testsLine = lines.find(line => line.startsWith('Tests:'));
  let results: TestResults = { passed: 0, failed: 0, total: 0, duration: 'unknown' };

  if (testsLine) {
    const passedMatch = testsLine.match(/(\d+) passed/);
    const failedMatch = testsLine.match(/(\d+) failed/);
    const totalMatch = testsLine.match(/(\d+) total/);

    results.passed = passedMatch ? parseInt(passedMatch[1], 10) : 0;
    results.failed = failedMatch ? parseInt(failedMatch[1], 10) : 0;
    results.total = totalMatch ? parseInt(totalMatch[1], 10) : results.passed + results.failed;
  }

  // Extract duration from "Time:" line
  const timeLine = lines.find(line => line.match(/Time:\s+[\d.]+\s*s/));
  if (timeLine) {
    const timeMatch = timeLine.match(/Time:\s+([\d.]+\s*s)/);
    if (timeMatch) {
      results.duration = timeMatch[1];
    }
  }

  // Extract test scenarios
  const scenarios: TestScenario[] = [];

  for (const line of lines) {
    // Check for describe blocks (e.g., "    1. Happy-Path Basics")
    // These are indented with 4 spaces and don't have ✓ or ✗
    if (line.match(/^\s{4}[0-9A-Z]/) && !line.includes('✓') && !line.includes('✗')) {
      const groupName = line.trim();
      scenarios.push({ name: groupName, passed: true, isGroup: true });
    }
    // Check for test results (lines with ✓ or ✗)
    else if (line.match(/^\s+[✓✗]/)) {
      const isPassed = line.includes('✓');
      // Remove leading whitespace, status symbol, and timing info
      const name = line.trim().replace(/^[✓✗]\s*/, '').replace(/\s*\(\d+\s*ms\)$/, '');
      scenarios.push({ name, passed: isPassed, isGroup: false });
    }
  }

  return { results, scenarios };
}

function generateSummary(testFile: string, testName: string, output: string): string {
  const { results, scenarios } = parseTestOutput(output);

  // Determine status emoji
  const statusEmoji = results.failed === 0 ? '✅' : '❌';

  let summary = `## ${statusEmoji} ${testName}\n\n`;
  summary += `**Test File:** \`${testFile}\`\n\n`;
  summary += `**Results:** ${results.passed} passed, ${results.failed} failed (Total: ${results.total}) in ${results.duration}\n\n`;

  if (scenarios.length > 0) {
    summary += `### Test Scenarios\n\n`;

    for (const scenario of scenarios) {
      if (scenario.isGroup) {
        summary += `\n**${scenario.name}**\n\n`;
      } else {
        const emoji = scenario.passed ? '✅' : '❌';
        summary += `- ${emoji} ${scenario.name}\n`;
      }
    }
  } else {
    summary += `_Test details not available in output_\n\n`;
    summary += `<details>\n<summary>Raw Test Output</summary>\n\n\`\`\`\n${output}\n\`\`\`\n\n</details>\n`;
  }

  return summary;
}

function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error('Usage: generate-test-summary.ts <test-file> <test-name> [<output-file>]');
    process.exit(1);
  }

  const testFile = args[0];
  const testName = args[1];
  const outputFile = args[2]; // Optional: file containing test output

  // Read test output from file or stdin
  let testOutput: string;
  if (outputFile && fs.existsSync(outputFile)) {
    testOutput = fs.readFileSync(outputFile, 'utf-8');
  } else {
    // Read from stdin
    testOutput = fs.readFileSync(0, 'utf-8');
  }

  // Generate summary
  const summary = generateSummary(testFile, testName, testOutput);

  // Write to GITHUB_STEP_SUMMARY or stdout
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    fs.appendFileSync(summaryPath, summary);
    console.log('Summary generated successfully');
  } else {
    console.error('Warning: GITHUB_STEP_SUMMARY not set. Running outside GitHub Actions?');
    console.log('\n--- Summary ---');
    console.log(summary);
  }
}

main();
