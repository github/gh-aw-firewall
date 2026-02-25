import execa = require('execa');
import * as fs from 'fs/promises';
import glob = require('glob');

/**
 * Cleanup utility for awf Docker resources and temporary files
 * Port of scripts/ci/cleanup.sh
 */
export class Cleanup {
  private verbose: boolean;

  constructor(verbose = false) {
    this.verbose = verbose;
  }

  private log(message: string): void {
    if (this.verbose) {
      console.log(message);
    }
  }

  /**
   * Remove awf containers by name
   */
  async removeContainers(): Promise<void> {
    this.log('Removing awf containers by name...');
    try {
      await execa('docker', ['rm', '-f', 'awf-squid', 'awf-agent', 'awf-api-proxy']);
    } catch (error) {
      // Ignore errors (containers may not exist)
    }
  }

  /**
   * Stop all docker-compose services in awf work directories
   */
  async stopDockerComposeServices(): Promise<void> {
    this.log('Stopping docker compose services...');

    // Find all awf work directories with docker-compose.yml
    const pattern = '/tmp/awf-*/docker-compose.yml';
    const composeFiles = glob.sync(pattern);

    for (const composeFile of composeFiles) {
      try {
        await execa('docker', ['compose', '-f', composeFile, 'down', '-v']);
      } catch (error) {
        // Ignore errors
      }
    }
  }

  /**
   * Clean up host-level iptables rules (FW_WRAPPER chain)
   */
  async cleanupIptables(): Promise<void> {
    this.log('Cleaning up host-level iptables rules...');

    try {
      // Check if FW_WRAPPER chain exists in DOCKER-USER
      const { stdout: dockerUserChain } = await execa('iptables', [
        '-t', 'filter',
        '-L', 'DOCKER-USER',
        '-n'
      ]);

      if (dockerUserChain.includes('FW_WRAPPER')) {
        this.log('  - Removing FW_WRAPPER rules from DOCKER-USER chain...');

        // Get line numbers with FW_WRAPPER rules
        const { stdout: lineNumbers } = await execa('iptables', [
          '-t', 'filter',
          '-L', 'DOCKER-USER',
          '-n',
          '--line-numbers'
        ]);

        // Extract line numbers in reverse order
        const lines = lineNumbers
          .split('\n')
          .filter(line => line.includes('FW_WRAPPER'))
          .map(line => parseInt(line.trim().split(/\s+/)[0]))
          .sort((a, b) => b - a); // Reverse order

        // Delete rules by line number
        for (const lineNum of lines) {
          try {
            await execa('iptables', [
              '-t', 'filter',
              '-D', 'DOCKER-USER',
              lineNum.toString()
            ]);
          } catch (error) {
            // Ignore errors
          }
        }
      }
    } catch (error) {
      // DOCKER-USER chain may not exist
    }

    try {
      // Check if FW_WRAPPER chain exists
      await execa('iptables', ['-t', 'filter', '-L', 'FW_WRAPPER', '-n']);

      this.log('  - Removing FW_WRAPPER chain...');
      // Flush and remove the chain
      try {
        await execa('iptables', ['-t', 'filter', '-F', 'FW_WRAPPER']);
      } catch (error) {
        // Ignore
      }
      try {
        await execa('iptables', ['-t', 'filter', '-X', 'FW_WRAPPER']);
      } catch (error) {
        // Ignore
      }
    } catch (error) {
      // FW_WRAPPER chain doesn't exist
    }
  }

  /**
   * Remove awf-net Docker network
   */
  async removeNetwork(): Promise<void> {
    this.log('Removing awf-net network...');
    try {
      await execa('docker', ['network', 'rm', 'awf-net']);
    } catch (error) {
      // Ignore errors (network may not exist)
    }
  }

  /**
   * Prune unused Docker containers
   */
  async pruneContainers(): Promise<void> {
    this.log('Pruning unused containers...');
    try {
      await execa('docker', ['container', 'prune', '-f']);
    } catch (error) {
      // Ignore errors
    }
  }

  /**
   * Prune unused Docker networks (fixes "Pool overlaps" errors)
   */
  async pruneNetworks(): Promise<void> {
    this.log('Pruning unused networks...');
    try {
      await execa('docker', ['network', 'prune', '-f']);
    } catch (error) {
      // Ignore errors
    }
  }

  /**
   * Remove temporary work directories (/tmp/awf-*)
   */
  async removeWorkDirectories(): Promise<void> {
    this.log('Removing temporary work directories...');

    const pattern = '/tmp/awf-*';
    const dirs = glob.sync(pattern);

    for (const dir of dirs) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch (error) {
        // Ignore errors
      }
    }
  }

  /**
   * Run full cleanup (all steps)
   */
  async cleanAll(): Promise<void> {
    if (this.verbose) {
      console.log('===========================================');
      console.log('Cleaning up awf resources');
      console.log('===========================================');
    }

    await this.removeContainers();
    await this.stopDockerComposeServices();
    await this.cleanupIptables();
    await this.removeNetwork();
    await this.pruneContainers();
    await this.pruneNetworks();
    await this.removeWorkDirectories();

    if (this.verbose) {
      console.log('✓ Cleanup complete');
      console.log('===========================================');
    }
  }
}

/**
 * Convenience function for running cleanup in Jest tests
 */
export async function cleanup(verbose = false): Promise<void> {
  const cleaner = new Cleanup(verbose);
  await cleaner.cleanAll();
}
