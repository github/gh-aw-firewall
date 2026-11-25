#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = process.env.GITHUB_WORKSPACE || path.resolve(__dirname, '../..');
const maintain = path.join(__dirname, 'maintain.cjs');
const compile = path.join(__dirname, 'compile.cjs');
const commands = {
  'refresh-import': [process.execPath, maintain, 'refresh-import'],
  'refresh-copilot-pricing': [process.execPath, maintain, 'refresh-copilot-pricing'],
  report: [process.execPath, maintain, 'report'],
  verify: [process.execPath, maintain, 'verify'],
  generate: [process.execPath, compile, '--maintenance-workspace'],
  check: [process.execPath, compile, '--maintenance-workspace', '--check'],
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
