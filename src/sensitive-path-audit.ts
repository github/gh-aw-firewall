import * as path from 'path';
import { ensureDirectory, writeFileNoFollow } from './fs-utils';

export function writeSensitivePathAudit(auditDir: string, audit: unknown): void {
  ensureDirectory(auditDir, { mode: 0o755 });
  writeFileNoFollow(
    path.join(auditDir, 'sensitive-paths.json'),
    JSON.stringify(audit, null, 2),
    0o644,
  );
}
