import { execa } from 'execa';

export interface DockerRunOptions {
  image: string;
  command?: string[];
  args?: string[];
  env?: Record<string, string>;
  network?: string;
  name?: string;
  rm?: boolean;
  detach?: boolean;
  interactive?: boolean;
  tty?: boolean;
  volumes?: string[]; // Format: "host:container"
  ports?: string[]; // Format: "host:container"
  capabilities?: string[]; // e.g., ["NET_ADMIN"]
}

export interface ContainerInspect {
  id: string;
  name: string;
  state: {
    running: boolean;
    exitCode: number;
  };
  networkSettings: {
    networks: Record<string, { ipAddress: string }>;
  };
}

/**
 * Helper class for Docker operations in tests
 */
export class DockerHelper {
  /**
   * Pull a Docker image
   */
  async pullImage(image: string): Promise<void> {
    await execa('docker', ['pull', image]);
  }

  /**
   * Run a Docker container
   */
  async run(options: DockerRunOptions): Promise<{ stdout: string; stderr: string; containerId?: string }> {
    const args: string[] = ['run'];

    // Add flags
    if (options.rm) {
      args.push('--rm');
    }

    if (options.detach) {
      args.push('-d');
    }

    if (options.interactive) {
      args.push('-i');
    }

    if (options.tty) {
      args.push('-t');
    }

    if (options.name) {
      args.push('--name', options.name);
    }

    if (options.network) {
      args.push('--network', options.network);
    }

    // Add environment variables
    if (options.env) {
      for (const [key, value] of Object.entries(options.env)) {
        args.push('-e', `${key}=${value}`);
      }
    }

    // Add volumes
    if (options.volumes) {
      for (const volume of options.volumes) {
        args.push('-v', volume);
      }
    }

    // Add ports
    if (options.ports) {
      for (const port of options.ports) {
        args.push('-p', port);
      }
    }

    // Add capabilities
    if (options.capabilities) {
      for (const cap of options.capabilities) {
        args.push('--cap-add', cap);
      }
    }

    // Add image
    args.push(options.image);

    // Add command and args
    if (options.command) {
      args.push(...options.command);
    }

    if (options.args) {
      args.push(...options.args);
    }

    const result = await execa('docker', args, { reject: false });

    return {
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      containerId: options.detach ? result.stdout?.trim() : undefined,
    };
  }

  /**
   * Stop a container
   */
  async stop(containerNameOrId: string): Promise<void> {
    await execa('docker', ['stop', containerNameOrId], { reject: false });
  }

  /**
   * Remove a container
   */
  async rm(containerNameOrId: string, force = false): Promise<void> {
    const args = ['rm'];
    if (force) {
      args.push('-f');
    }
    args.push(containerNameOrId);
    await execa('docker', args, { reject: false });
  }

  /**
   * Inspect a container
   */
  async inspect(containerNameOrId: string): Promise<ContainerInspect | null> {
    try {
      const { stdout } = await execa('docker', ['inspect', containerNameOrId]);
      const data = JSON.parse(stdout);

      if (!data || data.length === 0) {
        return null;
      }

      const container = data[0];

      return {
        id: container.Id,
        name: container.Name,
        state: {
          running: container.State.Running,
          exitCode: container.State.ExitCode,
        },
        networkSettings: {
          networks: container.NetworkSettings.Networks || {},
        },
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Get container logs
   */
  async logs(containerNameOrId: string, options?: { tail?: number; follow?: boolean }): Promise<string> {
    const args = ['logs'];

    if (options?.tail) {
      args.push('--tail', options.tail.toString());
    }

    if (options?.follow) {
      args.push('-f');
    }

    args.push(containerNameOrId);

    const { stdout } = await execa('docker', args);
    return stdout;
  }

  /**
   * Execute a command in a running container
   */
  async exec(
    containerNameOrId: string,
    command: string[],
    options?: { interactive?: boolean; tty?: boolean }
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const args = ['exec'];

    if (options?.interactive) {
      args.push('-i');
    }

    if (options?.tty) {
      args.push('-t');
    }

    args.push(containerNameOrId, ...command);

    const result = await execa('docker', args, { reject: false });

    return {
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      exitCode: result.exitCode || 0,
    };
  }

  /**
   * Check if a network exists
   */
  async networkExists(networkName: string): Promise<boolean> {
    try {
      await execa('docker', ['network', 'inspect', networkName]);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Create a network
   */
  async createNetwork(networkName: string, subnet?: string): Promise<void> {
    const args = ['network', 'create'];

    if (subnet) {
      args.push('--subnet', subnet);
    }

    args.push(networkName);

    await execa('docker', args);
  }

  /**
   * Remove a network
   */
  async removeNetwork(networkName: string): Promise<void> {
    await execa('docker', ['network', 'rm', networkName], { reject: false });
  }

  /**
   * List containers
   */
  async listContainers(options?: { all?: boolean; filters?: Record<string, string> }): Promise<string[]> {
    const args = ['ps', '--format', '{{.Names}}'];

    if (options?.all) {
      args.push('-a');
    }

    if (options?.filters) {
      for (const [key, value] of Object.entries(options.filters)) {
        args.push('--filter', `${key}=${value}`);
      }
    }

    const { stdout } = await execa('docker', args);
    return stdout.split('\n').filter((name: string) => name.trim() !== '');
  }

  /**
   * Wait for a container to exit and return its exit code
   */
  async wait(containerNameOrId: string): Promise<number> {
    const { stdout } = await execa('docker', ['wait', containerNameOrId]);
    return parseInt(stdout.trim(), 10);
  }

  /**
   * Check if a container is running
   */
  async isRunning(containerNameOrId: string): Promise<boolean> {
    const info = await this.inspect(containerNameOrId);
    return info?.state.running || false;
  }
}

/**
 * Convenience function for creating a DockerHelper
 */
export function createDockerHelper(): DockerHelper {
  return new DockerHelper();
}
