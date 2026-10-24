#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = process.env.GITHUB_WORKSPACE || path.resolve(__dirname, '../..');
const maintain = path.join(root, 'scripts/model-information/maintain.cjs');
const commands = {
  'refresh-import': [process.execPath, maintain, 'refresh-import'],
  report: [process.execPath, maintain, 'report'],
  verify: [process.execPath, maintain, 'verify'],
  generate: ['npm', 'run', 'models:generate'],
  check: ['npm', 'run', 'models:check'],
  test: ['npm', 'test', '--', '--runInBand', 'scripts/model-information/',
    'scripts/ci/model-api-mapping-updater-workflow.test.ts',
    'src/copilot-model-catalog-sync.test.ts', 'src/model-information-contract.test.ts'],
  'test-api-proxy': ['npm', '--prefix', 'containers/api-proxy', 'test', '--',
    '--runInBand', 'models-dev-catalog.test.js', 'ai-credits-pricing-reference.test.js'],
};

function runMaintenanceCommand(args, spawn = spawnSync) {
  if (args.length !== 1 || !Object.hasOwn(commands, args[0])) {
    throw new Error(`Expected exactly one maintenance command: ${Object.keys(commands).join(', ')}`);
  }
  const [command, ...parameters] = commands[args[0]];
  const result = spawn(command, parameters, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Maintenance command ${args[0]} terminated by ${result.signal}`);
  if (!Number.isInteger(result.status)) throw new Error(`Maintenance command ${args[0]} returned no exit status`);
  return result.status;
}

module.exports = { runMaintenanceCommand };

if (require.main === module) {
  try {
    process.exitCode = runMaintenanceCommand(process.argv.slice(2));
  } catch (error) {
    console.error(`Model maintenance failed: ${error.message}`);
    process.exitCode = 1;
  }
}
