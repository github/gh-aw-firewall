/**
 * Escapes a shell argument by wrapping it in single quotes and escaping any single quotes within it
 */
function escapeShellArg(arg: string): string {
  // If the argument doesn't contain special characters, return as-is
  // Character class includes: letters, digits, underscore, dash, dot (literal), slash, equals, colon
  if (/^[a-zA-Z0-9_\-./=:]+$/.test(arg)) {
    return arg;
  }
  // Otherwise, wrap in single quotes and escape any single quotes inside
  // The pattern '\'' works by: ending the single-quoted string ('),
  // adding an escaped single quote (\'), then starting a new single-quoted string (')
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Joins an array of shell arguments into a single command string, properly escaping each argument
 */
export function joinShellArgs(args: string[]): string {
  return args.map(escapeShellArg).join(' ');
}
