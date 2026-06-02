import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';
import { cleanupSslKeyMaterial, unmountSslTmpfs } from './ssl-bump';
import {
  preserveCleanupArtifacts,
  removeWorkDirectories,
} from './artifact-preservation';

export { collectDiagnosticLogs } from './diagnostic-collector';
export { runComposeDown, stopContainers } from './container-stop';
export { preserveIptablesAudit } from './artifact-preservation';

export async function cleanup(
  workDir: string,
  keepFiles: boolean,
  proxyLogsDir?: string,
  auditDir?: string,
  sessionStateDir?: string,
): Promise<void> {
  if (keepFiles) {
    logger.debug(`Keeping temporary files in: ${workDir}`);
    return;
  }

  logger.debug('Cleaning up temporary files...');
  try {
    if (!fs.existsSync(workDir)) {
      return;
    }

    preserveCleanupArtifacts(workDir, { proxyLogsDir, auditDir, sessionStateDir });

    cleanupSslKeyMaterial(workDir);

    const sslDir = path.join(workDir, 'ssl');
    if (fs.existsSync(sslDir)) {
      await unmountSslTmpfs(sslDir);
    }

    removeWorkDirectories(workDir);
    logger.debug('Temporary files cleaned up');
  } catch (error) {
    logger.warn('Failed to clean up temporary files:', error);
  }
}
