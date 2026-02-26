import execa = require('execa');
import * as path from 'path';

type ExecaReturnValue = execa.ExecaReturnValue<string>;

export interface AwfOptions {
  allowDomains?: string[];
  blockDomains?: string[];
  keepContainers?: boolean;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  buildLocal?: boolean;
  imageRegistry?: string;
  imageTag?: string;
  timeout?: number; // milliseconds
  env?: Record<string, string>;
  volumeMounts?: string[]; // Volume mounts in format: host_path:container_path[:mode]
  containerWorkDir?: string; // Working directory inside the container
  tty?: boolean; // Allocate pseudo-TTY (required for interactive tools like Claude Code)
  dnsServers?: string[]; // DNS servers to use (e.g., ['8.8.8.8', '2001:4860:4860::8888'])
  allowHostPorts?: string; // Ports or port ranges to allow for host access (e.g., '3000' or '3000-8000')
  enableApiProxy?: boolean; // Enable API proxy sidecar for LLM credential management
  rateLimitRpm?: number; // Requests per minute per provider
  rateLimitRph?: number; // Requests per hour per provider
  rateLimitBytesPm?: number; // Request bytes per minute per provider
  noRateLimit?: boolean; // Disable rate limiting
  envAll?: boolean; // Pass all host environment variables to container (--env-all)
  cliEnv?: Record<string, string>; // Explicit -e KEY=VALUE flags passed to AWF CLI
}

export interface AwfResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  success: boolean;
  timedOut: boolean;
  workDir?: string; // Extracted from stderr logs
}

/**
 * Helper class for running awf commands in tests
 */
export class AwfRunner {
  private awfPath: string;

  constructor(awfPath?: string) {
    // Default to the built CLI in dist/cli.js
    this.awfPath = awfPath || path.resolve(__dirname, '../../dist/cli.js');
  }

  /**
   * Run an awf command
   */
  async run(command: string, options: AwfOptions = {}): Promise<AwfResult> {
    const args: string[] = [];

    // Add allow-domains
    if (options.allowDomains && options.allowDomains.length > 0) {
      args.push('--allow-domains', options.allowDomains.join(','));
    }

    // Add block-domains
    if (options.blockDomains && options.blockDomains.length > 0) {
      args.push('--block-domains', options.blockDomains.join(','));
    }

    // Add other flags
    if (options.keepContainers) {
      args.push('--keep-containers');
    }

    if (options.logLevel) {
      args.push('--log-level', options.logLevel);
    }

    if (options.buildLocal) {
      args.push('--build-local');
    }

    if (options.imageRegistry) {
      args.push('--image-registry', options.imageRegistry);
    }

    if (options.imageTag) {
      args.push('--image-tag', options.imageTag);
    }

    // Add volume mounts
    if (options.volumeMounts && options.volumeMounts.length > 0) {
      options.volumeMounts.forEach(mount => {
        args.push('--mount', mount);
      });
    }

    // Add container working directory
    if (options.containerWorkDir) {
      args.push('--container-workdir', options.containerWorkDir);
    }

    // Add TTY flag
    if (options.tty) {
      args.push('--tty');
    }

    // Add DNS servers
    if (options.dnsServers && options.dnsServers.length > 0) {
      args.push('--dns-servers', options.dnsServers.join(','));
    }

    // Add allow-host-ports
    if (options.allowHostPorts) {
      args.push('--allow-host-ports', options.allowHostPorts);
    }

    // Add enable-api-proxy flag
    if (options.enableApiProxy) {
      args.push('--enable-api-proxy');
    }

    // Add rate limit flags
    if (options.rateLimitRpm !== undefined) {
      args.push('--rate-limit-rpm', String(options.rateLimitRpm));
    }
    if (options.rateLimitRph !== undefined) {
      args.push('--rate-limit-rph', String(options.rateLimitRph));
    }
    if (options.rateLimitBytesPm !== undefined) {
      args.push('--rate-limit-bytes-pm', String(options.rateLimitBytesPm));
    }
    if (options.noRateLimit) {
      args.push('--no-rate-limit');
    }

    // Add --env-all flag
    if (options.envAll) {
      args.push('--env-all');
    }

    // Add explicit -e KEY=VALUE flags
    if (options.cliEnv) {
      for (const [key, value] of Object.entries(options.cliEnv)) {
        args.push('-e', `${key}=${value}`);
      }
    }

    // Add -- separator before command
    args.push('--');

    // Add the command to execute
    args.push(command);

    const execOptions = {
      reject: false, // Don't throw on non-zero exit
      all: true,
      timeout: options.timeout || 120000, // Default 2 minutes
      env: {
        ...process.env,
        ...options.env,
      },
    };

    let result: ExecaReturnValue;

    try {
      result = await execa('node', [this.awfPath, ...args], execOptions);
    } catch (error: any) {
      // Handle timeout
      if (error.timedOut) {
        return {
          exitCode: -1,
          stdout: error.stdout || '',
          stderr: error.stderr || '',
          success: false,
          timedOut: true,
        };
      }
      throw error;
    }

    // Extract work directory from stderr logs
    const workDir = this.extractWorkDir(result.stderr || '');

    // Normalize exit code to handle undefined (defaults to 0)
    const exitCode = result.exitCode ?? 0;

    return {
      exitCode,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      success: exitCode === 0,
      timedOut: false,
      workDir,
    };
  }

  /**
   * Run awf with sudo (required for iptables manipulation)
   *
   * @param command - Command to execute:
   *   - String: Complete shell command (may contain $vars, pipes, redirects)
   *            Passed as single argument to preserve shell syntax
   *   - Array: Pre-parsed argv array, each element will be shell-escaped
   *
   * IMPORTANT: When passing strings with shell variables like $HOME or $(pwd),
   * use the string format to ensure they expand in the container, not on host.
   *
   * Examples:
   *   runWithSudo('echo $HOME && pwd')  // Variables expand in container ✅
   *   runWithSudo(['echo', '$HOME'])    // Literal string "$HOME" ❌
   */
  async runWithSudo(command: string, options: AwfOptions = {}): Promise<AwfResult> {
    const args: string[] = [];

    // Preserve environment variables using both -E and --preserve-env for critical vars
    // This is needed because sudo's env_reset may strip vars even with -E
    args.push('-E');

    // Explicitly preserve PATH and tool-specific environment variables
    // These are needed for chroot mode to find binaries on GitHub Actions runners
    const criticalEnvVars = [
      'PATH',
      'HOME',
      'USER',
      'GOROOT',
      'CARGO_HOME',
      'JAVA_HOME',
      'DOTNET_ROOT',
    ].filter(v => process.env[v]);

    if (criticalEnvVars.length > 0) {
      args.push('--preserve-env=' + criticalEnvVars.join(','));
    }

    // Add awf path
    args.push('node', this.awfPath);

    // Add allow-domains
    if (options.allowDomains && options.allowDomains.length > 0) {
      args.push('--allow-domains', options.allowDomains.join(','));
    }

    // Add block-domains
    if (options.blockDomains && options.blockDomains.length > 0) {
      args.push('--block-domains', options.blockDomains.join(','));
    }

    // Add other flags
    if (options.keepContainers) {
      args.push('--keep-containers');
    }

    if (options.logLevel) {
      args.push('--log-level', options.logLevel);
    }

    if (options.buildLocal) {
      args.push('--build-local');
    }

    if (options.imageRegistry) {
      args.push('--image-registry', options.imageRegistry);
    }

    if (options.imageTag) {
      args.push('--image-tag', options.imageTag);
    }

    // Add volume mounts
    if (options.volumeMounts && options.volumeMounts.length > 0) {
      options.volumeMounts.forEach(mount => {
        args.push('--mount', mount);
      });
    }

    // Add container working directory
    if (options.containerWorkDir) {
      args.push('--container-workdir', options.containerWorkDir);
    }

    // Add TTY flag
    if (options.tty) {
      args.push('--tty');
    }

    // Add DNS servers
    if (options.dnsServers && options.dnsServers.length > 0) {
      args.push('--dns-servers', options.dnsServers.join(','));
    }

    // Add allow-host-ports
    if (options.allowHostPorts) {
      args.push('--allow-host-ports', options.allowHostPorts);
    }

    // Add enable-api-proxy flag
    if (options.enableApiProxy) {
      args.push('--enable-api-proxy');
    }

    // Add rate limit flags
    if (options.rateLimitRpm !== undefined) {
      args.push('--rate-limit-rpm', String(options.rateLimitRpm));
    }
    if (options.rateLimitRph !== undefined) {
      args.push('--rate-limit-rph', String(options.rateLimitRph));
    }
    if (options.rateLimitBytesPm !== undefined) {
      args.push('--rate-limit-bytes-pm', String(options.rateLimitBytesPm));
    }
    if (options.noRateLimit) {
      args.push('--no-rate-limit');
    }

    // Add --env-all flag
    if (options.envAll) {
      args.push('--env-all');
    }

    // Add explicit -e KEY=VALUE flags
    if (options.cliEnv) {
      for (const [key, value] of Object.entries(options.cliEnv)) {
        args.push('-e', `${key}=${value}`);
      }
    }

    // Add -- separator before command
    args.push('--');

    // Add the command to execute
    args.push(command);

    const execOptions = {
      reject: false,
      all: true,
      timeout: options.timeout || 120000,
      env: {
        ...process.env,
        ...options.env,
      },
    };

    let result: ExecaReturnValue;

    try {
      result = await execa('sudo', args, execOptions);
    } catch (error: any) {
      if (error.timedOut) {
        return {
          exitCode: -1,
          stdout: error.stdout || '',
          stderr: error.stderr || '',
          success: false,
          timedOut: true,
        };
      }
      throw error;
    }

    const workDir = this.extractWorkDir(result.stderr || '');

    // Normalize exit code to handle undefined (defaults to 0)
    const exitCode = result.exitCode ?? 0;

    return {
      exitCode,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      success: exitCode === 0,
      timedOut: false,
      workDir,
    };
  }

  /**
   * Extract work directory from awf stderr logs
   * Looks for patterns like "[INFO] Using work directory: /tmp/awf-1234567890"
   */
  private extractWorkDir(stderr: string): string | undefined {
    const match = stderr.match(/Using work directory: (\/tmp\/awf-\d+)/);
    return match ? match[1] : undefined;
  }
}

/**
 * Convenience function for creating an AwfRunner
 */
export function createRunner(awfPath?: string): AwfRunner {
  return new AwfRunner(awfPath);
}
