/**
 * Batch Runner - runs multiple commands in a single AWF container invocation.
 *
 * Each test that calls runner.run() spawns a full Docker container
 * lifecycle (~15-25s overhead). This utility batches commands that share the
 * same allowDomains config into one invocation, cutting container startups
 * from ~73 to ~27 across the chroot test suite.
 *
 * Usage:
 *   const results = await runBatch(runner, [
 *     { name: 'python_version', command: 'python3 --version' },
 *     { name: 'node_version', command: 'node --version' },
 *   ], { allowDomains: ['github.com'] });
 *
 *   // Each test asserts against its own result:
 *   expect(results.get('python_version').exitCode).toBe(0);
 */

import { AwfRunner, AwfOptions, AwfResult } from './awf-runner';

export interface BatchCommand {
  name: string;
  command: string;
}

export interface BatchCommandResult {
  stdout: string;
  exitCode: number;
}

export interface BatchResults {
  /** Get result for a named command. Throws if name not found. */
  get(name: string): BatchCommandResult;
  /** The raw AWF result for the entire batch invocation. */
  overall: AwfResult;
}

// Delimiter tokens – chosen to be unlikely in real command output
const START = '===BATCH_START:';
const EXIT  = '===BATCH_EXIT:';
const DELIM_END = '===';

/**
 * Build a bash script that runs each command in a subshell, capturing its
 * exit code and delimiting its output.
 */
function generateScript(commands: BatchCommand[]): string {
  return commands.map(cmd => {
    // Each command runs in a subshell so failures don't abort the batch.
    // stdout and stderr are merged (2>&1) so we capture everything.
    // IMPORTANT: capture $? immediately into _EC before echo resets it.
    return [
      `echo "${START}${cmd.name}${DELIM_END}"`,
      `(${cmd.command}) 2>&1`,
      `_EC=$?`,
      `echo ""`,
      `echo "${EXIT}${cmd.name}:$_EC${DELIM_END}"`,
    ].join('; ');
  }).join('; ');
}

/**
 * Parse the combined stdout into per-command results.
 */
function parseResults(stdout: string, commands: BatchCommand[]): Map<string, BatchCommandResult> {
  const results = new Map<string, BatchCommandResult>();

  for (const cmd of commands) {
    const startToken = `${START}${cmd.name}${DELIM_END}`;
    const exitPattern = new RegExp(`${EXIT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${cmd.name}:(\\d+)${DELIM_END}`);

    const startIdx = stdout.indexOf(startToken);
    const exitMatch = stdout.match(exitPattern);

    if (startIdx === -1 || !exitMatch) {
      // Command output not found – likely the batch was killed early
      results.set(cmd.name, { stdout: '', exitCode: -1 });
      continue;
    }

    const contentStart = startIdx + startToken.length;
    const contentEnd = stdout.indexOf(exitMatch[0], contentStart) - 1; // -1 for the blank line
    const cmdStdout = stdout.slice(contentStart, contentEnd).trim();
    const exitCode = parseInt(exitMatch[1], 10);

    results.set(cmd.name, { stdout: cmdStdout, exitCode });
  }

  return results;
}

/**
 * Run multiple commands in a single AWF container invocation.
 *
 * All commands share the same AwfOptions (allowDomains, timeout, etc.).
 * Individual command results are parsed from delimited output.
 */
export async function runBatch(
  runner: AwfRunner,
  commands: BatchCommand[],
  options: AwfOptions,
): Promise<BatchResults> {
  const script = generateScript(commands);
  const result = await runner.run(script, options);
  const parsed = parseResults(result.stdout, commands);

  return {
    get(name: string): BatchCommandResult {
      const r = parsed.get(name);
      if (!r) {
        throw new Error(`Batch command "${name}" not found in results. Available: ${[...parsed.keys()].join(', ')}`);
      }
      return r;
    },
    overall: result,
  };
}
