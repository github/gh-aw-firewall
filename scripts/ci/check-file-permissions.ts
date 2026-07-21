#!/usr/bin/env npx ts-node
/**
 * File Permissions Checker for AWF
 *
 * Static analysis: Scans production source for temp directory creation patterns
 * that are vulnerable to restrictive umask settings (e.g., 0177 on some GitHub
 * Actions runners causing mkdtempSync to create dirs with mode 0600 instead of 0700).
 *
 * Runtime tests: Verifies that directory creation functions actually produce
 * directories with correct permissions under restrictive umask.
 *
 * Background: Between July 2–16 2026, at least 8 separate EACCES bugs were caused
 * by runner environments with unexpected umask/ownership conditions. This checker
 * prevents regressions by catching missing chmod calls and verifying runtime behavior.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const SRC_DIR = path.resolve(__dirname, '../../src');

interface Finding {
  file: string;
  line: number;
  pattern: string;
  severity: 'error' | 'warning';
  message: string;
}

// ─── Static Analysis ────────────────────────────────────────────────────────

/**
 * Checks that every mkdtempSync call in production code is followed by
 * an explicit chmodSync within 3 lines (to override umask).
 */
function checkMkdtempSyncChmod(findings: Finding[]): void {
  const sourceFiles = getAllSourceFiles(SRC_DIR);

  for (const filePath of sourceFiles) {
    if (isTestFile(filePath)) continue;

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes('mkdtempSync')) continue;
      // Skip comments
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;

      // Handle both single-line and multiline assignments:
      //   const dir = fs.mkdtempSync(...)        — single line
      //   const dir =\n  fs.mkdtempSync(...)     — split across lines
      let varName: string | null = null;

      // Try single-line match
      const singleLineMatch = line.match(/(?:const|let|var)\s+(\w+)\s*=\s*(?:fs\.)?mkdtempSync/);
      if (singleLineMatch) {
        varName = singleLineMatch[1];
      } else {
        // Check if mkdtempSync is on a continuation line (look back up to 3 lines for assignment)
        for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
          const prevLine = lines[j];
          const assignMatch = prevLine.match(/(?:const|let|var)\s+(\w+)\s*=\s*$/);
          if (assignMatch) {
            varName = assignMatch[1];
            break;
          }
          // Also match: const dir = \n  something.mkdtempSync
          const trailingAssign = prevLine.match(/(?:const|let|var)\s+(\w+)\s*=\s*\S/);
          if (trailingAssign) break; // assignment completed on that line, not ours
        }
      }

      if (!varName) continue;

      // Look for chmodSync on that variable within the next 5 lines
      let foundChmod = false;
      for (let j = i + 1; j <= i + 5 && j < lines.length; j++) {
        if (lines[j].includes('chmodSync') && lines[j].includes(varName)) {
          foundChmod = true;
          break;
        }
      }

      if (!foundChmod) {
        findings.push({
          file: path.relative(process.cwd(), filePath),
          line: i + 1,
          pattern: 'mkdtempSync-without-chmod',
          severity: 'error',
          message:
            `mkdtempSync result '${varName}' is not followed by chmodSync within 5 lines. ` +
            `Restrictive umask (e.g., 0177) can cause the directory to be created with mode 0600 ` +
            `(missing execute bit), making file creation inside it fail with EACCES.`,
        });
      }
    }
  }
}

/**
 * Checks that mkdirSync calls with explicit mode also have a chmodSync
 * follow-up (since mkdirSync mode is also affected by umask).
 */
function checkMkdirSyncModeHardening(findings: Finding[]): void {
  const sourceFiles = getAllSourceFiles(SRC_DIR);

  // These files are known to handle chmod correctly via ensureDirectory() or
  // other wrapper patterns that apply chmod internally
  const ALLOWLISTED_PATTERNS = [
    'fs-utils.ts',         // ensureDirectory helper itself
    'log-directory-setup.ts', // uses ensureDirectory with explicit chmod callbacks
  ];

  for (const filePath of sourceFiles) {
    if (isTestFile(filePath)) continue;

    const basename = path.basename(filePath);
    if (ALLOWLISTED_PATTERNS.includes(basename)) continue;

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Match: mkdirSync(path, { ... mode: 0o700 ... }) where security-relevant mode
      if (!line.includes('mkdirSync')) continue;
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;

      // Only care about calls with explicit restrictive modes (0o700, 0o755)
      const modeMatch = line.match(/mkdirSync\([^)]*mode:\s*(0o7\d{2})/);
      if (!modeMatch) continue;

      // Check if there's a chmodSync for the same path within the next 5 lines
      let foundChmod = false;
      for (let j = i + 1; j <= i + 5 && j < lines.length; j++) {
        if (lines[j].includes('chmodSync')) {
          foundChmod = true;
          break;
        }
      }

      // Also check if the mkdirSync result is guarded (e.g., in config-writer.ts
      // where chmodSync is called for pre-existing dirs in an else branch)
      if (!foundChmod) {
        // Look for chmodSync within 15 lines (to cover if/else patterns)
        for (let j = i + 1; j <= i + 15 && j < lines.length; j++) {
          if (lines[j].includes('chmodSync') && lines[j].includes(modeMatch[1])) {
            foundChmod = true;
            break;
          }
        }
      }

      if (!foundChmod) {
        findings.push({
          file: path.relative(process.cwd(), filePath),
          line: i + 1,
          pattern: 'mkdirSync-mode-without-chmod',
          severity: 'warning',
          message:
            `mkdirSync with mode ${modeMatch[1]} is not followed by a chmodSync. ` +
            `The mode parameter is affected by process umask and may not produce the intended permissions. ` +
            `Consider adding an explicit chmodSync to guarantee the mode.`,
        });
      }
    }
  }
}

/**
 * Checks that writeFileSync into temp directories has appropriate error
 * handling for EACCES (defense-in-depth for environments with restrictive
 * security policies like AppArmor or SELinux).
 */
function checkWriteFileSyncInTempDirs(findings: Finding[]): void {
  const sourceFiles = getAllSourceFiles(SRC_DIR);

  for (const filePath of sourceFiles) {
    if (isTestFile(filePath)) continue;

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes('writeFileSync')) continue;
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;

      // Check if the path involves a temp directory pattern
      const isTempPath = line.includes('tmpdir') ||
        line.includes('workDir') ||
        line.includes('/tmp/');
      if (!isTempPath) continue;

      // Check if this writeFileSync is inside a try block (look back 10 lines)
      let insideTry = false;
      for (let j = Math.max(0, i - 10); j < i; j++) {
        if (lines[j].trim().startsWith('try')) {
          insideTry = true;
          break;
        }
      }

      if (!insideTry) {
        findings.push({
          file: path.relative(process.cwd(), filePath),
          line: i + 1,
          pattern: 'writeFileSync-no-try-catch',
          severity: 'warning',
          message:
            `writeFileSync to a temp directory path without try/catch. ` +
            `On runners with restrictive policies, this can crash with EACCES. ` +
            `Consider wrapping in try/catch with a diagnostic fallback.`,
        });
      }
    }
  }
}

/**
 * Checks that cleanup/preservation file operations (rmSync, renameSync, readdirSync,
 * copyFileSync, chmodSync via execa, chownSync) are wrapped in try/catch with
 * EACCES-aware error handling.
 *
 * These operations are especially vulnerable because they operate on directories
 * that may have been created by Docker containers running as different UIDs (root,
 * proxy UID 13, remapped rootless UIDs).
 */
function checkCleanupOperationsErrorHandling(findings: Finding[]): void {
  const CLEANUP_FILES = [
    'artifact-preservation.ts',
    'artifact-permissions.ts',
    'container-cleanup.ts',
    'container-stop.ts',
    'ssl-key-storage.ts',
    'ssl-bump.ts',
    'chroot-home-setup.ts',
    'log-directory-setup.ts',
    'diagnostic-collector.ts',
  ];

  const DANGEROUS_OPS = [
    'rmSync', 'rmdirSync', 'unlinkSync', 'renameSync',
    'readdirSync', 'copyFileSync', 'chownSync', 'chmodSync',
    'openSync', 'writeSync',
  ];

  const sourceFiles = getAllSourceFiles(SRC_DIR);

  for (const filePath of sourceFiles) {
    if (isTestFile(filePath)) continue;

    const basename = path.basename(filePath);
    if (!CLEANUP_FILES.includes(basename)) continue;

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;

      const matchedOp = DANGEROUS_OPS.find(op => line.includes(`fs.${op}`) || line.includes(`.${op}(`));
      if (!matchedOp) continue;

      // Check if inside a try block (look back up to 20 lines for cleanup files)
      let insideTry = false;
      let braceDepth = 0;
      for (let j = i; j >= Math.max(0, i - 20); j--) {
        const checkLine = lines[j];
        braceDepth += (checkLine.match(/\}/g) || []).length;
        braceDepth -= (checkLine.match(/\{/g) || []).length;
        if (checkLine.trim().match(/^\s*try\s*\{?/) && braceDepth <= 0) {
          insideTry = true;
          break;
        }
      }

      if (!insideTry) {
        findings.push({
          file: path.relative(process.cwd(), filePath),
          line: i + 1,
          pattern: 'cleanup-op-unguarded',
          severity: 'warning',
          message:
            `Cleanup file operation 'fs.${matchedOp}' is not inside a try/catch block. ` +
            `Cleanup operations handle files/dirs that may be owned by Docker containers ` +
            `(root, UID 13, remapped UIDs) and can fail with EACCES/EPERM. ` +
            `Wrap in try/catch for resilience.`,
        });
      }
    }
  }
}

/**
 * Checks that execa.sync('chmod', ...) calls in cleanup code handle failures
 * gracefully (i.e., are inside try/catch or use reject:false).
 */
function checkExecaChmodErrorHandling(findings: Finding[]): void {
  const sourceFiles = getAllSourceFiles(SRC_DIR);

  for (const filePath of sourceFiles) {
    if (isTestFile(filePath)) continue;

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;

      // Match execa.sync('chmod', ...) or execa.sync('chown', ...)
      if (!line.match(/execa\.sync\(\s*['"`](chmod|chown)['"`]/)) continue;

      // Check for reject:false in the same line or next few lines
      let hasRejectFalse = false;
      let insideTry = false;

      for (let j = i; j <= i + 3 && j < lines.length; j++) {
        if (lines[j].includes('reject: false') || lines[j].includes('reject:false')) {
          hasRejectFalse = true;
          break;
        }
      }

      // Check if inside try block
      for (let j = i; j >= Math.max(0, i - 15); j--) {
        if (lines[j].trim().match(/^\s*try\s*\{?/)) {
          insideTry = true;
          break;
        }
      }

      if (!hasRejectFalse && !insideTry) {
        findings.push({
          file: path.relative(process.cwd(), filePath),
          line: i + 1,
          pattern: 'execa-chmod-unguarded',
          severity: 'warning',
          message:
            `execa.sync chmod/chown without try/catch or reject:false. ` +
            `On rootless Docker or cross-UID cleanup, these operations can fail. ` +
            `Use try/catch or { reject: false } to prevent cleanup crashes.`,
        });
      }
    }
  }
}

// ─── Runtime Tests ──────────────────────────────────────────────────────────

interface RuntimeTestResult {
  name: string;
  passed: boolean;
  message: string;
}

/**
 * Verifies that mkdtempSync + chmodSync produces a directory we can actually
 * write files into, even under a restrictive umask.
 */
function testMkdtempWithRestrictiveUmask(): RuntimeTestResult {
  const oldUmask = process.umask(0o177); // Most restrictive common umask
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-perm-check-'));
    const rawStat = fs.statSync(dir);
    const rawMode = rawStat.mode & 0o7777;

    // Without chmod, this would be 0o600 (umask 0177 applied to 0777)
    fs.chmodSync(dir, 0o700);

    const fixedStat = fs.statSync(dir);
    const fixedMode = fixedStat.mode & 0o7777;

    // Verify we can create a file inside
    const testFile = path.join(dir, 'test');
    fs.writeFileSync(testFile, 'test', { mode: 0o644 });
    fs.unlinkSync(testFile);
    fs.rmdirSync(dir);

    return {
      name: 'mkdtempSync-with-chmod-under-restrictive-umask',
      passed: true,
      message: `Dir created with mode ${rawMode.toString(8)}, fixed to ${fixedMode.toString(8)}, file write succeeded`,
    };
  } catch (err: unknown) {
    return {
      name: 'mkdtempSync-with-chmod-under-restrictive-umask',
      passed: false,
      message: `Failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    process.umask(oldUmask);
  }
}

/**
 * Demonstrates the failure mode: mkdtempSync WITHOUT chmod under restrictive
 * umask should fail to allow file creation on Linux.
 */
function testMkdtempWithoutChmodFails(): RuntimeTestResult {
  const oldUmask = process.umask(0o177);
  let dir = '';
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-perm-check-nochmod-'));
    const stat = fs.statSync(dir);
    const mode = stat.mode & 0o7777;

    // Try to write — this should fail with EACCES under mode 0600
    const testFile = path.join(dir, 'test');
    try {
      fs.writeFileSync(testFile, 'test', { mode: 0o600 });
      // If it succeeds, the OS/filesystem ignores directory execute bit for owner
      fs.unlinkSync(testFile);

      // On Linux, this MUST fail — if it doesn't, the umask isn't being applied
      // and our chmod fix has no testable effect on this environment.
      if (os.platform() === 'linux') {
        return {
          name: 'mkdtempSync-without-chmod-fails (umask enforcement)',
          passed: false,
          message:
            `Dir mode=${mode.toString(8)} but file write succeeded on Linux. ` +
            `Expected EACCES — the runner environment does not enforce directory execute bits, ` +
            `so permission bugs cannot be caught here.`,
        };
      }

      // macOS and other platforms may allow this (owner bypass)
      return {
        name: 'mkdtempSync-without-chmod-fails (umask enforcement)',
        passed: true,
        message: `Dir mode=${mode.toString(8)}. OS allows file creation regardless (expected on ${os.platform()}); chmod is still needed for Linux runners.`,
      };
    } catch (writeErr: unknown) {
      if (writeErr && typeof writeErr === 'object' && 'code' in writeErr && writeErr.code === 'EACCES') {
        return {
          name: 'mkdtempSync-without-chmod-fails (umask enforcement)',
          passed: true,
          message: `Confirmed: dir mode=${mode.toString(8)}, file write correctly fails with EACCES. This validates that chmod is required.`,
        };
      }
      throw writeErr;
    }
  } catch (err: unknown) {
    return {
      name: 'mkdtempSync-without-chmod-fails (umask enforcement)',
      passed: false,
      message: `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    process.umask(oldUmask);
    if (dir) {
      try { fs.rmdirSync(dir); } catch { /* best effort */ }
    }
  }
}

/**
 * Verifies that mkdirSync with mode + chmodSync produces correct permissions.
 */
function testMkdirSyncModeWithChmod(): RuntimeTestResult {
  const oldUmask = process.umask(0o177);
  const dir = path.join(os.tmpdir(), `awf-perm-check-mkdir-${Date.now()}`);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const rawStat = fs.statSync(dir);
    const rawMode = rawStat.mode & 0o7777;

    fs.chmodSync(dir, 0o700);
    const fixedStat = fs.statSync(dir);
    const fixedMode = fixedStat.mode & 0o7777;

    // Verify writable
    const testFile = path.join(dir, 'test');
    fs.writeFileSync(testFile, 'test', { mode: 0o600 });
    fs.unlinkSync(testFile);
    fs.rmdirSync(dir);

    return {
      name: 'mkdirSync-mode-with-chmod-under-restrictive-umask',
      passed: true,
      message: `Created with mode=${rawMode.toString(8)}, fixed to ${fixedMode.toString(8)}, write succeeded`,
    };
  } catch (err: unknown) {
    return {
      name: 'mkdirSync-mode-with-chmod-under-restrictive-umask',
      passed: false,
      message: `Failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    process.umask(oldUmask);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  }
}

/**
 * Verifies the actual hosts-file.ts generateHostsFileMount pattern works.
 */
function testHostsFileMountPattern(): RuntimeTestResult {
  const oldUmask = process.umask(0o177);
  let workDir = '';
  try {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-perm-hostsfile-'));
    fs.chmodSync(workDir, 0o700);

    // Replicate the exact hosts-file.ts pattern
    const chrootHostsDir = fs.mkdtempSync(path.join(workDir, 'chroot-'));
    fs.chmodSync(chrootHostsDir, 0o700);
    const chrootHostsPath = path.join(chrootHostsDir, 'hosts');
    fs.writeFileSync(chrootHostsPath, '127.0.0.1 localhost\n', { mode: 0o644 });

    const content = fs.readFileSync(chrootHostsPath, 'utf-8');
    if (!content.includes('localhost')) {
      throw new Error('hosts file content verification failed');
    }

    return {
      name: 'hosts-file-mount-pattern',
      passed: true,
      message: 'mkdtempSync + chmodSync + writeFileSync pattern works correctly under restrictive umask',
    };
  } catch (err: unknown) {
    return {
      name: 'hosts-file-mount-pattern',
      passed: false,
      message: `Failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    process.umask(oldUmask);
    if (workDir) {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* */ }
    }
  }
}

/**
 * Verifies that nested directory creation (workDir > subdir > file) works
 * under restrictive umask with proper chmod at each level.
 */
function testNestedDirectoryPermissions(): RuntimeTestResult {
  const oldUmask = process.umask(0o177);
  let baseDir = '';
  try {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-perm-nested-'));
    fs.chmodSync(baseDir, 0o700);

    // Level 1: mkdir with mode
    const level1 = path.join(baseDir, 'level1');
    fs.mkdirSync(level1, { mode: 0o755 });
    fs.chmodSync(level1, 0o755);

    // Level 2: mkdtemp inside level1
    const level2 = fs.mkdtempSync(path.join(level1, 'sub-'));
    fs.chmodSync(level2, 0o700);

    // Write file at level 2
    const filePath = path.join(level2, 'data.txt');
    fs.writeFileSync(filePath, 'nested test', { mode: 0o644 });
    const content = fs.readFileSync(filePath, 'utf-8');

    if (content !== 'nested test') {
      throw new Error('Content mismatch');
    }

    return {
      name: 'nested-directory-permissions',
      passed: true,
      message: 'Three-level nested directory creation with chmod works under restrictive umask',
    };
  } catch (err: unknown) {
    return {
      name: 'nested-directory-permissions',
      passed: false,
      message: `Failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    process.umask(oldUmask);
    if (baseDir) {
      try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch { /* */ }
    }
  }
}

/**
 * Simulates the cleanup artifact preservation pattern:
 * Create dirs as different effective mode, then verify rename/readdir/chmod
 * operations succeed or fail gracefully.
 */
function testCleanupRenamePattern(): RuntimeTestResult {
  const oldUmask = process.umask(0o177);
  let workDir = '';
  try {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-perm-cleanup-'));
    fs.chmodSync(workDir, 0o700);

    // Create subdirs simulating agent-logs, squid-logs, audit
    const agentLogs = path.join(workDir, 'agent-logs');
    fs.mkdirSync(agentLogs);
    fs.chmodSync(agentLogs, 0o755);
    fs.writeFileSync(path.join(agentLogs, 'test.log'), 'log data', { mode: 0o644 });

    const squidLogs = path.join(workDir, 'squid-logs');
    fs.mkdirSync(squidLogs);
    fs.chmodSync(squidLogs, 0o755);
    fs.writeFileSync(path.join(squidLogs, 'access.log'), 'squid data', { mode: 0o644 });

    // Test renameSync (artifact preservation pattern)
    const dest = path.join(os.tmpdir(), `awf-perm-cleanup-dest-${Date.now()}`);
    fs.renameSync(agentLogs, dest);

    // Test readdirSync on the destination
    const files = fs.readdirSync(dest);
    if (!files.includes('test.log')) {
      throw new Error('readdirSync after rename failed to list files');
    }

    // Test rmSync (workDir removal pattern)
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });

    return {
      name: 'cleanup-rename-readdir-rm-pattern',
      passed: true,
      message: 'Artifact preservation (rename + readdir + rmSync) works under restrictive umask',
    };
  } catch (err: unknown) {
    return {
      name: 'cleanup-rename-readdir-rm-pattern',
      passed: false,
      message: `Failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    process.umask(oldUmask);
    if (workDir) {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* */ }
    }
  }
}

/**
 * Tests the chmod-repair-retry pattern used in removeWorkDirectories():
 * When rmSync fails on a restricted directory, chmod to fix permissions
 * then retry. This validates the local repair logic (not the Docker-based
 * fixArtifactPermissionsForRootless which requires a real Docker daemon).
 */
function testChmodRepairRetryPattern(): RuntimeTestResult {
  let testDir = '';
  try {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-perm-repair-'));
    fs.chmodSync(testDir, 0o700);

    // Create a subdirectory, write a file, then restrict permissions
    const restrictedDir = path.join(testDir, 'restricted');
    fs.mkdirSync(restrictedDir);
    fs.chmodSync(restrictedDir, 0o755);
    fs.writeFileSync(path.join(restrictedDir, 'file.txt'), 'data', { mode: 0o644 });
    // Now remove write permission (simulates root-owned dir after container exit)
    fs.chmodSync(restrictedDir, 0o555);

    // Attempt removal — may fail with EACCES/EPERM/ENOTEMPTY
    try {
      fs.rmSync(restrictedDir, { recursive: true, force: true });
      return {
        name: 'chmod-repair-retry-pattern',
        passed: true,
        message: 'rmSync with force:true succeeded on restricted directory (OS owner bypass)',
      };
    } catch (err: unknown) {
      const code = err && typeof err === 'object' && 'code' in err ? (err as any).code : 'unknown';
      if (code === 'EACCES' || code === 'EPERM' || code === 'ENOTEMPTY') {
        // This is the repair pattern from removeWorkDirectories():
        // chmod to restore permissions, then retry removal
        fs.chmodSync(restrictedDir, 0o755);
        fs.rmSync(restrictedDir, { recursive: true, force: true });
        return {
          name: 'chmod-repair-retry-pattern',
          passed: true,
          message: `rmSync fails with ${code} on restricted dir; chmod(0755) + retry succeeds`,
        };
      }
      throw err;
    }
  } catch (err: unknown) {
    return {
      name: 'chmod-repair-retry-pattern',
      passed: false,
      message: `Failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    if (testDir) {
      try {
        // Ensure cleanup
        for (const entry of fs.readdirSync(testDir)) {
          const p = path.join(testDir, entry);
          try { fs.chmodSync(p, 0o755); } catch { /* */ }
        }
        fs.rmSync(testDir, { recursive: true, force: true });
      } catch { /* */ }
    }
  }
}

/**
 * Verifies the chroot-home-setup prepareChrootHomeMountpoint pattern:
 * mkdirSync + chownSync + chmodSync in a loop.
 */
function testChrootHomeMountpointPattern(): RuntimeTestResult {
  const oldUmask = process.umask(0o177);
  let baseDir = '';
  try {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-perm-chroot-home-'));
    fs.chmodSync(baseDir, 0o755);

    // Simulate prepareChrootHomeMountpoint: create nested dirs with chown+chmod
    const segments = ['work', '_tool', 'node', '20'];
    let current = baseDir;
    const uid = process.getuid?.() ?? 1000;
    const gid = process.getgid?.() ?? 1000;

    for (const segment of segments) {
      current = path.join(current, segment);
      fs.mkdirSync(current);
      fs.chownSync(current, uid, gid);
      fs.chmodSync(current, 0o755);
    }

    // Verify leaf is writable
    const testFile = path.join(current, 'test');
    fs.writeFileSync(testFile, 'tool data', { mode: 0o644 });
    const content = fs.readFileSync(testFile, 'utf-8');
    if (content !== 'tool data') {
      throw new Error('Content verification failed');
    }

    return {
      name: 'chroot-home-mountpoint-pattern',
      passed: true,
      message: 'Nested mkdirSync + chownSync + chmodSync loop works under restrictive umask',
    };
  } catch (err: unknown) {
    return {
      name: 'chroot-home-mountpoint-pattern',
      passed: false,
      message: `Failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    process.umask(oldUmask);
    if (baseDir) {
      try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch { /* */ }
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getAllSourceFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') {
      results.push(...getAllSourceFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      results.push(fullPath);
    }
  }
  return results;
}

function isTestFile(filePath: string): boolean {
  const basename = path.basename(filePath);
  return basename.includes('.test.') || basename.includes('.spec.') ||
    basename.includes('test-utils') || basename.includes('test-helpers') ||
    filePath.includes('/test-helpers/');
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main(): void {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║       AWF File Permissions Checker                          ║');
  console.log('║       Prevents EACCES regressions from umask/ownership bugs ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  // ─── Part 1: Static Analysis ────────────────────────────────────────────
  console.log('── Static Analysis ──────────────────────────────────────────\n');

  const findings: Finding[] = [];

  checkMkdtempSyncChmod(findings);
  checkMkdirSyncModeHardening(findings);
  checkWriteFileSyncInTempDirs(findings);
  checkCleanupOperationsErrorHandling(findings);
  checkExecaChmodErrorHandling(findings);

  const errors = findings.filter(f => f.severity === 'error');
  const warnings = findings.filter(f => f.severity === 'warning');

  if (findings.length === 0) {
    console.log('✅ No permission anti-patterns found in production source code.\n');
  } else {
    for (const f of errors) {
      console.log(`❌ ERROR [${f.pattern}] ${f.file}:${f.line}`);
      console.log(`   ${f.message}\n`);
    }
    for (const f of warnings) {
      console.log(`⚠️  WARNING [${f.pattern}] ${f.file}:${f.line}`);
      console.log(`   ${f.message}\n`);
    }
    console.log(`Static analysis: ${errors.length} error(s), ${warnings.length} warning(s)\n`);
  }

  // ─── Part 2: Runtime Tests ──────────────────────────────────────────────
  console.log('── Runtime Tests (restrictive umask=0177) ───────────────────\n');

  const runtimeTests: RuntimeTestResult[] = [
    testMkdtempWithRestrictiveUmask(),
    testMkdtempWithoutChmodFails(),
    testMkdirSyncModeWithChmod(),
    testHostsFileMountPattern(),
    testNestedDirectoryPermissions(),
    testCleanupRenamePattern(),
    testChmodRepairRetryPattern(),
    testChrootHomeMountpointPattern(),
  ];

  let runtimeFailures = 0;
  for (const result of runtimeTests) {
    const icon = result.passed ? '✅' : '❌';
    console.log(`${icon} ${result.name}`);
    console.log(`   ${result.message}\n`);
    if (!result.passed) runtimeFailures++;
  }

  // ─── Part 3: Environment Info ───────────────────────────────────────────
  console.log('── Environment Info ─────────────────────────────────────────\n');

  const currentUmask = process.umask(0o022);
  process.umask(currentUmask);
  console.log(`  Process UID:    ${process.getuid?.() ?? 'N/A'}`);
  console.log(`  Process GID:    ${process.getgid?.() ?? 'N/A'}`);
  console.log(`  Process umask:  0o${currentUmask.toString(8)}`);
  console.log(`  OS tmpdir:      ${os.tmpdir()}`);
  console.log(`  Platform:       ${os.platform()} ${os.release()}`);
  console.log(`  Node version:   ${process.version}\n`);

  // Check /tmp permissions
  try {
    const tmpStat = fs.statSync(os.tmpdir());
    console.log(`  ${os.tmpdir()} mode: 0o${(tmpStat.mode & 0o7777).toString(8)} uid=${tmpStat.uid} gid=${tmpStat.gid}`);
  } catch (err) {
    console.log(`  ${os.tmpdir()} stat failed: ${err}`);
  }
  console.log('');

  // ─── Summary ────────────────────────────────────────────────────────────
  const totalIssues = errors.length + runtimeFailures;
  if (totalIssues > 0) {
    console.log(`\n❌ FAILED: ${errors.length} static error(s) + ${runtimeFailures} runtime failure(s)`);
    process.exit(1);
  } else if (warnings.length > 0) {
    console.log(`\n⚠️  PASSED with ${warnings.length} warning(s) (non-blocking)`);
    process.exit(0);
  } else {
    console.log('\n✅ ALL CHECKS PASSED');
    process.exit(0);
  }
}

main();
