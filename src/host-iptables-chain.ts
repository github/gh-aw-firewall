import execa from 'execa';
import { logger } from './logger';
import { cleanupChain } from './host-iptables-shared';
import { getErrorStringProperty, isMissingIptablesError } from './host-iptables-validation';

export async function checkPermissionsAndSetupChain(chain: string): Promise<void> {
  try {
    await execa('iptables', ['--version'], { timeout: 5000 });
  } catch (error: unknown) {
    if (isMissingIptablesError(error)) {
      throw new Error('iptables is required but was not found. Please install iptables and try again.');
    }
    throw error;
  }

  try {
    await execa('iptables', ['-t', 'filter', '-L', 'DOCKER-USER', '-n'], { timeout: 5000 });
  } catch (error: unknown) {
    if (isMissingIptablesError(error)) {
      throw new Error('iptables is required but was not found. Please install iptables and try again.');
    }
    const stderr = getErrorStringProperty(error, 'stderr');
    if (stderr.includes('Permission denied')) {
      throw new Error(
        'Permission denied: iptables commands require root privileges. ' +
        'Please run this command with sudo.'
      );
    }
    logger.warn('DOCKER-USER chain does not exist, which is unexpected. Attempting to create it...');
    try {
      await execa('iptables', ['-t', 'filter', '-N', 'DOCKER-USER']);
    } catch {
      throw new Error(
        'Failed to create DOCKER-USER chain. This may indicate a permission or Docker installation issue.'
      );
    }
  }

  logger.debug(`Creating dedicated chain '${chain}'...`);

  try {
    const { exitCode } = await execa('iptables', ['-t', 'filter', '-L', chain, '-n'], { reject: false });
    if (exitCode === 0) {
      logger.debug(`Chain '${chain}' already exists, cleaning up...`);
      await cleanupChain('iptables', chain);
    }
  } catch (error) {
    logger.debug('Error during chain cleanup:', error);
  }

  await execa('iptables', ['-t', 'filter', '-N', chain]);
}

export async function insertDockerUserJumpRule(chain: string, bridgeName: string): Promise<void> {
  const { exitCode: ruleExists } = await execa('iptables', [
    '-t', 'filter', '-C', 'DOCKER-USER',
    '-i', bridgeName,
    '-j', chain,
  ], { reject: false });

  if (ruleExists !== 0) {
    logger.debug(`Inserting rule in DOCKER-USER to jump to ${chain} for bridge ${bridgeName}...`);
    await execa('iptables', [
      '-t', 'filter', '-I', 'DOCKER-USER', '1',
      '-i', bridgeName,
      '-j', chain,
    ]);
  } else {
    logger.debug(`Rule for bridge ${bridgeName} already exists in DOCKER-USER`);
  }
}

export async function logChainDebugOutput(chain: string): Promise<void> {
  logger.debug('DOCKER-USER chain:');
  const { stdout: dockerUserRules } = await execa('iptables', [
    '-t', 'filter', '-L', 'DOCKER-USER', '-n', '-v',
  ]);
  logger.debug(dockerUserRules);

  logger.debug(`${chain} chain:`);
  const { stdout: chainRules } = await execa('iptables', [
    '-t', 'filter', '-L', chain, '-n', '-v',
  ]);
  logger.debug(chainRules);
}
