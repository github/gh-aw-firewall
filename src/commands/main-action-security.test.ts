import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { testHelpers } from './main-action';

describe('incomplete enclave audit marker', () => {
  it('rejects a symlink without modifying its target', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-audit-marker-test-'));
    const auditDir = path.join(tempDir, 'audit');
    const targetPath = path.join(tempDir, 'outside.txt');
    const markerPath = path.join(auditDir, 'enclave-audit-incomplete.txt');

    try {
      fs.mkdirSync(auditDir, { mode: 0o755 });
      fs.writeFileSync(targetPath, 'unchanged');
      fs.symlinkSync(targetPath, markerPath);

      expect(() => testHelpers.writeIncompleteEnclaveAuditMarker(auditDir)).toThrow();
      expect(fs.readFileSync(targetPath, 'utf8')).toBe('unchanged');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
