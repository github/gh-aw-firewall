import { joinShellArgs } from '../../option-parsers';

const REFLECT_COMMAND = 'curl --fail --silent --show-error --noproxy "*" http://api-proxy:10000/reflect';

export function assembleAgentCommand(args: string[], reflect: boolean): string {
  // Require -- separator for passing command arguments
  if (args.length === 0 && !reflect) {
    console.error('Error: No command specified. Use -- to separate command from options.');
    console.error('Example: awf --allow-domains github.com -- curl https://api.github.com');
    process.exit(1);
  }
  if (reflect && args.length > 0) {
    console.error('Error: --reflect cannot be used with a command.');
    process.exit(1);
  }

  // A single argument is a complete shell command: preserve $HOME, $(command),
  // etc. for expansion in the container, not on the host. Multiple arguments
  // have already been parsed by the user's shell and must be escaped and joined.
  return reflect
    ? REFLECT_COMMAND
    : args.length === 1 ? args[0] : joinShellArgs(args);
}
