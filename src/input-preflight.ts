import { shellSingleQuote } from './cloud-hypervisor/backend-utils';

/**
 * Check declared inputs under the workload identity, after runtime mounts and
 * privilege dropping. This does not validate an engine's file-scope policy.
 */
export function withInputPreflight(command: string, inputDirs?: string[]): string {
  if (!inputDirs?.length) return command;

  const checkEntries = `for entry do
  if [ -d "$entry" ]; then
    [ -r "$entry" ] && [ -x "$entry" ] || exit 1
  elif [ -f "$entry" ]; then
    cat -- "$entry" >/dev/null || exit 1
    printf '.'
  else
    exit 1
  fi
done`;

  return `(
for input in ${inputDirs.map(shellSingleQuote).join(' ')}; do
  if [ ! -d "$input" ] || ! files=$(find -L "$input" -exec /bin/sh -c ${shellSingleQuote(checkEntries)} sh {} +) || [ -z "$files" ]; then
    printf 'AWF input preflight failed: missing, empty, or unreadable input directory: %s\\n' "$input" >&2
    exit 1
  fi
done
) || exit 1
${command}`;
}
