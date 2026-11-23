'use strict';

/**
 * Meta-commands that are always denied.
 * These modify gh itself rather than GitHub resources.
 */
const ALWAYS_DENIED_SUBCOMMANDS = new Set([
  'alias',
  'auth',
  'browse',
  'config',
  'extension',
]);
const DENIED_COMMAND_PATHS = new Set([
  'codespace',
  'gist clone',
  'pr checkout',
  'repo clone',
  'repo fork',
  'repo sync',
]);

// Built-in/default aliases of policy-controlled commands in the pinned gh CLI.
// User aliases are not loaded: the sidecar owns its private GH_CONFIG_DIR.
const ROOT_COMMAND_ALIASES = new Map([
  ['co', ['pr', 'checkout']],
  ['cs', ['codespace']],
  ['ext', ['extension']],
  ['extensions', ['extension']],
]);
const ROOT_DISCOVERY_BOOLEANS = new Set(['--help', '--version']);
const GROUP_DISCOVERY_BOOLEANS = new Set(['--help']);

function findCommandIndex(args, booleanFlags) {
  // Match Cobra's stripFlags command discovery, not final leaf flag parsing.
  // Unknown long/single-short flags consume a separate value; attached and
  // equals forms do not. In particular, -h is not registered during discovery.
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') break;
    if (arg !== '' && !arg.startsWith('-')) return index;
    if (
      arg.startsWith('-')
      && !arg.includes('=')
      && (arg.startsWith('--') || Buffer.byteLength(arg, 'utf8') === 2)
      && !booleanFlags.has(arg)
    ) {
      index += 1;
    }
  }
  return -1;
}

function findCommandIndices(args) {
  const rootIndex = findCommandIndex(args, ROOT_DISCOVERY_BOOLEANS);
  if (rootIndex < 0) return [];

  // Cobra removes the selected command, then searches the entire remaining
  // vector again using that group's flags (including flags before the root).
  const remaining = args.filter((_arg, index) => index !== rootIndex);
  const groupIndex = findCommandIndex(remaining, GROUP_DISCOVERY_BOOLEANS);
  return [
    rootIndex,
    groupIndex < 0 ? -1 : groupIndex + (groupIndex >= rootIndex ? 1 : 0),
  ];
}

function resolveCommandPath(args) {
  const [rootIndex, commandIndex] = findCommandIndices(args);
  if (rootIndex === undefined) return [];
  const root = args[rootIndex];
  if (ROOT_COMMAND_ALIASES.has(root)) return ROOT_COMMAND_ALIASES.get(root);
  let command = args[commandIndex];
  if (root === 'pr' && command === 'co') command = 'checkout';
  if ((root === 'gist' || root === 'release') && command === 'new') command = 'create';
  return [root, command];
}

module.exports = {
  ALWAYS_DENIED_SUBCOMMANDS,
  DENIED_COMMAND_PATHS,
  findCommandIndices,
  resolveCommandPath,
};
