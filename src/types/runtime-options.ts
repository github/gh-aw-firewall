/**
 * Runtime and execution configuration options.
 */

import type { LogLevel } from './log-level';

export interface RuntimeOptions {
  /**
   * The command to execute inside the firewall container
   * 
   * This command runs inside an Ubuntu-based Docker container with iptables rules
   * that redirect all HTTP/HTTPS traffic through a Squid proxy. The command has
   * access to the host filesystem (mounted at /host and ~).
   * 
   * @example 'npx @github/copilot --prompt "list files"'
   * @example 'curl https://api.github.com/zen'
   */
  agentCommand: string;

  /**
   * Logging verbosity level
   * 
   * Controls which log messages are displayed:
   * - 'debug': All messages including detailed diagnostics
   * - 'info': Informational messages and above
   * - 'warn': Warnings and errors only
   * - 'error': Errors only
   */
  logLevel: LogLevel;

  /**
   * Whether to preserve containers and configuration files after execution
   *
   * When true:
   * - Docker containers are not stopped or removed
   * - Work directory and all config files remain on disk
   * - Useful for debugging, inspecting logs, and troubleshooting
   *
   * When false (default):
   * - Containers are stopped and removed via 'docker compose down -v'
   * - Work directory is deleted (except preserved log directories)
   * - Squid and agent logs are moved to /tmp if they exist
   */
  keepContainers: boolean;

  /**
   * Whether to allocate a pseudo-TTY for the agent execution container
   *
   * When true:
   * - Allocates a pseudo-TTY (stdin becomes a TTY)
   * - Required for interactive CLI tools like Claude Code that use Ink/raw mode
   * - Logs will contain ANSI escape sequences (colors, cursor movements)
   *
   * When false (default):
   * - No TTY allocation (stdin is a pipe)
   * - Clean logs without ANSI escape sequences
   * - Interactive tools requiring TTY will hang or fail
   *
   * @default false
   */
  tty?: boolean;

  /**
   * Additional environment variables to pass to the agent execution container
   * 
   * These variables are explicitly passed to the container and are accessible
   * to the command and any MCP servers. Common use cases include API tokens,
   * configuration values, and credentials.
   * 
   * @example { GITHUB_TOKEN: 'ghp_...', OPENAI_API_KEY: 'sk-...' }
   */
  additionalEnv?: Record<string, string>;

  /**
   * Whether to pass all host environment variables to the container
   *
   * When true, all environment variables from the host (excluding system variables
   * like PATH, HOME, etc.) are passed to the agent execution container. This is useful for
   * development but may pose security risks in production.
   *
   * When false (default), only variables specified in additionalEnv are passed.
   *
   * @default false
   */
  envAll?: boolean;

  /**
   * Additional environment variable names to exclude when using --env-all
   *
   * When `envAll` is true, these variable names are excluded from the host environment
   * passthrough in addition to the built-in exclusion list (PATH, HOME, etc.).
   * Has no effect when `envAll` is false.
   *
   * @example ['GITHUB_MCP_SERVER_TOKEN', 'GH_AW_GITHUB_TOKEN']
   */
  excludeEnv?: string[];

  /**
   * Path to a file containing environment variables to inject into the container
   *
   * The file should contain KEY=VALUE pairs, one per line. Lines starting with
   * '#' are treated as comments and ignored. Empty lines are also ignored.
   * Variables in the file are injected before `additionalEnv` (--env flags),
   * so explicit --env values take precedence.
   *
   * Excluded system variables (PATH, HOME, etc.) are never injected regardless
   * of whether they appear in the file.
   *
   * @example '/tmp/runtime-paths.env'
   */
  envFile?: string;

  /**
   * Maximum time in minutes to allow the agent command to run
   *
   * When specified, the agent container is forcibly stopped after this many
   * minutes. Useful for large projects where builds or tests may exceed
   * default CI timeouts.
   *
   * When not specified, the agent runs indefinitely until the command completes
   * or the process is externally terminated.
   *
   * @default undefined (no timeout)
   * @example 30
   * @example 45
   */
  agentTimeout?: number;

  /**
   * Chroot identity override applied inside the agent entrypoint.
   *
   * These values are forwarded to the entrypoint and applied after `chroot /host`
   * so tools that rely on HOME/USER identity (for example Copilot CLI state under
   * `~/.copilot`) can run against DinD-staged writable paths.
   */
  chrootIdentity?: {
    home?: string;
    user?: string;
    uid?: number;
    gid?: number;
  };

  /**
   * Optional host directory of runner-installed binaries to overlay at
   * `/usr/local/bin` inside chroot mode.
   *
   * This is primarily for split-filesystem ARC/DinD runners where `/usr` in the
   * daemon filesystem does not contain binaries installed on the runner.
   */
  chrootBinariesSourcePath?: string;

  /**
   * ARC/DinD bootstrap configuration for split runner/daemon filesystems.
   */
  dind?: {
    preStageDirs?: boolean;
    workDir?: string;
    stagingImage?: string;
    stageEngineBinary?: {
      path?: string;
      targetPath?: string;
    };
  };
}
