'use strict';

const { findCommandIndices, resolveCommandPath } = require('./command-policy');

const STDIN_FILE_FLAGS = new Set(['--input', '--body-file', '--notes-file']);

function validatePositionalFileInputArgs(args) {
  const [group, command] = resolveCommandPath(args);
  const gist = group === 'gist' && (command === 'create' || command === 'edit');
  const release = group === 'release' && (command === 'create' || command === 'upload');
  if (!gist && !release) return { valid: true };

  const valueFlags = new Set(gist
    ? ['--desc', '-d', '--filename', '-f']
    : ['--repo', '-R']);
  const booleanFlags = new Set(['--help', '-h']);
  if (gist && command === 'edit') {
    valueFlags.add('--add').add('-a').add('--remove').add('-r');
  } else if (gist) {
    booleanFlags.add('--public').add('-p');
  } else if (command === 'upload') {
    booleanFlags.add('--clobber');
  } else {
    for (const flag of [
      '--discussion-category', '--notes', '-n', '--notes-file', '-F',
      '--notes-start-tag', '--target', '--title', '-t',
    ]) valueFlags.add(flag);
    for (const flag of [
      '--draft', '-d', '--fail-on-no-commits', '--generate-notes', '--latest',
      '--notes-from-tag', '--prerelease', '-p', '--verify-tag',
    ]) booleanFlags.add(flag);
  }

  const commandIndices = findCommandIndices(args);
  const tokens = args.filter((_arg, index) => !commandIndices.includes(index));
  const positionals = [];
  let gistAdd = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const arg = tokens[index];
    if (arg === '--') {
      positionals.push(...tokens.slice(index + 1));
      break;
    }
    if (arg === '-' || !arg.startsWith('-')) {
      positionals.push(arg);
      continue;
    }
    const long = arg.startsWith('--');
    const equals = long ? arg.indexOf('=') : -1;
    // Walk short clusters once; value-taking flags consume the remainder.
    for (let offset = 1; offset < arg.length; offset += 1) {
      const flag = long ? (equals < 0 ? arg : arg.slice(0, equals)) : `-${arg[offset]}`;
      if (booleanFlags.has(flag)) {
        if (long || arg[offset + 1] === '=') break;
        continue;
      }
      if (!valueFlags.has(flag)) {
        return { valid: false, error: `Flag '${flag}' is not permitted for ${group} ${command}` };
      }
      let value = long
        ? (equals < 0 ? undefined : arg.slice(equals + 1))
        : arg.slice(offset + 1) || undefined;
      if (!long && value?.startsWith('=')) value = value.slice(1);
      if (value === undefined) value = tokens[++index];
      if (value === undefined) return { valid: false, error: `${flag} requires a value` };
      if ((flag === '-F' || flag === '--notes-file') && value !== '-') {
        return { valid: false, error: `${flag} permits only stdin` };
      }
      if ((flag === '--add' || flag === '-a') && value !== '') gistAdd = true;
      break;
    }
  }
  const invalidPositionals = gist && command === 'create'
    ? positionals.some((arg) => arg !== '-')
    : gist
      ? positionals.length > 2
        || (positionals.length === 2 && positionals[1] !== '-')
        || (gistAdd && positionals[1] !== '-')
      : positionals.length > 1;
  if (invalidPositionals) {
    return { valid: false, error: `Positional file inputs are not permitted for ${group} ${command}` };
  }
  return { valid: true };
}

// Short flags that consume values on commands where -F reads a file or field.
const SHORT_VALUE_FLAGS = new Map([
  ['api', 'FHqXpft'],
  ['workflow run', 'FfrR'],
  ['issue create', 'FablmptTR'],
  ['issue edit', 'FbmtR'],
  ['issue comment', 'FbR'],
  ['pr create', 'FaBbHlmprTtR'],
  ['pr edit', 'FBbmtR'],
  ['pr comment', 'FbR'],
  ['pr review', 'FbR'],
  ['pr merge', 'FAbtR'],
  ['pr revert', 'FbtR'],
  ['discussion create', 'FbcltR'],
  ['discussion edit', 'FbctR'],
  ['discussion comment', 'FbR'],
  ['release create', 'FntR'],
  ['release edit', 'FntR'],
]);
const LONG_VALUE_FLAGS = new Set([
  '--add-assignee', '--add-blocked-by', '--add-blocking', '--add-label',
  '--add-project', '--add-reviewer', '--add-sub-issue', '--assignee', '--attach',
  '--author-email', '--base', '--blocked-by', '--blocking', '--body', '--body-file',
  '--cache', '--category', '--discussion-category', '--field', '--header', '--head',
  '--input', '--jq', '--label', '--match-head-commit', '--method', '--milestone',
  '--notes', '--notes-file', '--notes-start-tag', '--parent', '--preview', '--project',
  '--raw-field', '--recover', '--ref', '--remove-assignee', '--remove-blocked-by',
  '--remove-blocking', '--remove-label', '--remove-project', '--remove-reviewer',
  '--remove-sub-issue', '--repo', '--reviewer', '--subject', '--tag', '--target',
  '--template', '--title', '--type',
]);
const LONG_BOOLEAN_FLAGS = new Set([
  '--admin', '--allow-escape-sequences', '--auto', '--create-if-none', '--delete',
  '--delete-branch', '--delete-last', '--disable-auto', '--draft', '--dry-run',
  '--edit', '--edit-last', '--editor', '--fail-on-no-commits', '--fill',
  '--fill-first', '--fill-verbose', '--generate-notes', '--help', '--include',
  '--json', '--latest', '--merge', '--no-maintainer-edit', '--notes-from-tag',
  '--paginate', '--prerelease', '--rebase', '--remove-milestone', '--remove-parent',
  '--remove-type', '--request-changes', '--approve', '--comment', '--silent',
  '--slurp', '--squash', '--verbose', '--verify-tag', '--web', '--yes',
]);

function validateShortFileInputArgs(args) {
  const [group, command] = resolveCommandPath(args);
  const path = group === 'api' ? group : `${group} ${command === 'new' ? 'create' : command}`;
  const valueFlags = SHORT_VALUE_FLAGS.get(path);
  if (!valueFlags) return { valid: true };
  const field = path === 'api' || path === 'workflow run';
  const commandIndices = findCommandIndices(args);
  const tokens = args.filter((_arg, index) => (
    index !== commandIndices[0] && (group === 'api' || index !== commandIndices[1])
  ));
  const validateValue = (value) => {
    if (field) {
      const equals = value.indexOf('=');
      const content = equals < 0 ? '' : value.slice(equals + 1);
      return !content.startsWith('@') || content === '@-';
    }
    return value === '-';
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const arg = tokens[index];
    if (arg === '--') break;
    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=');
      const flag = equals < 0 ? arg : arg.slice(0, equals);
      if (LONG_VALUE_FLAGS.has(flag)) {
        const value = equals < 0 ? tokens[++index] : arg.slice(equals + 1);
        if (field && flag === '--field' && value !== undefined && !validateValue(value)) {
          return { valid: false, error: '--field file values permit only stdin' };
        }
      } else if (!LONG_BOOLEAN_FLAGS.has(flag)) {
        return { valid: false, error: `Flag '${flag}' is not permitted for ${path}` };
      }
      continue;
    }
    if (!arg.startsWith('-') || arg === '-') continue;
    for (let offset = 1; offset < arg.length; offset += 1) {
      const flag = arg[offset];
      if (!valueFlags.includes(flag)) continue;
      let value = arg.slice(offset + 1);
      if (value.startsWith('=')) value = value.slice(1);
      else if (value === '') value = tokens[++index];
      if (flag === 'F' && value !== undefined && !validateValue(value)) {
        return { valid: false, error: '-F file values permit only stdin' };
      }
      break;
    }
  }
  return { valid: true };
}

function validateFileInputArgs(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (STDIN_FILE_FLAGS.has(arg)) {
      if (args[index + 1] !== '-') {
        return { valid: false, error: `${arg} permits only stdin` };
      }
      index += 1;
      continue;
    }
    const fileFlag = [...STDIN_FILE_FLAGS].find((flag) => arg.startsWith(`${flag}=`));
    if (fileFlag && arg !== `${fileFlag}=-`) {
      return { valid: false, error: `${fileFlag} permits only stdin` };
    }
  }
  const shortFlags = validateShortFileInputArgs(args);
  return shortFlags.valid ? validatePositionalFileInputArgs(args) : shortFlags;
}

module.exports = {
  validateFileInputArgs,
};
