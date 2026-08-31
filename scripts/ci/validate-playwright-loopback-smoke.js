#!/usr/bin/env node

const fs = require('fs');

const expectedRuntime = process.argv[2];
const resultPath = '/tmp/gh-aw/agent/playwright-loopback-results.json';

if (!expectedRuntime) {
  throw new Error('Expected runtime argument is required');
}
if (!fs.existsSync(resultPath)) {
  throw new Error(`Playwright loopback result not found: ${resultPath}`);
}

const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
const failures = [];

if (result.runtime !== expectedRuntime) {
  failures.push(`runtime: expected ${expectedRuntime}, received ${result.runtime ?? 'missing'}`);
}
for (const key of ['loopback', 'javascript_title', 'blocked_egress']) {
  if (result[key] !== 'PASS') {
    failures.push(`${key}: expected PASS, received ${result[key] ?? 'missing'}`);
  }
}
if (!String(result.url ?? '').startsWith('http://127.0.0.1:')) {
  failures.push(`url: expected loopback URL, received ${result.url ?? 'missing'}`);
}

if (failures.length > 0) {
  throw new Error(`Playwright loopback smoke test failed:\n${failures.join('\n')}`);
}

console.log(`Playwright loopback smoke test passed for ${expectedRuntime}`);
