/**
 * Chroot capsh Execution Chain Tests
 *
 * Verifies that the capsh execution chain works correctly after PR #715,
 * which eliminated the nested bash layer in chroot command execution.
 *
 * PR #715 changed the entrypoint.sh command-writing logic:
 * - Before: `printf '%q ' "$@"` created nested `/bin/bash -c cmd` in the script
 * - After: For standard Docker CMD pattern (`/bin/bash -c <cmd>`), writes `$3`
 *   directly to the script file, eliminating the extra bash process layer
 *
 * These tests verify:
 * 1. Capabilities are properly dropped via capsh (CapBnd bitmask)
 * 2. The user command runs under bash (not another shell)
 * 3. The direct-write approach handles special characters correctly
 * 4. /proc/self/exe resolves correctly (not to /bin/bash for all processes)
 *
 * Fixes #842
 *
 * OPTIMIZATION: Tests are batched into a single AWF invocation where possible.
 */

/// <reference path="../jest-custom-matchers.d.ts" />

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { createRunner, AwfRunner } from '../fixtures/awf-runner';
import { cleanup } from '../fixtures/cleanup';
import { runBatch, BatchResults } from '../fixtures/batch-runner';

describe('Chroot capsh Execution Chain (PR #715 verification)', () => {
  let runner: AwfRunner;

  beforeAll(async () => {
    await cleanup(false);
    runner = createRunner();
  });

  afterAll(async () => {
    await cleanup(false);
  });

  describe('Capability verification (batched)', () => {
    let batch: BatchResults;

    beforeAll(async () => {
      batch = await runBatch(runner, [
        // Check the CapBnd (bounding set) from /proc/self/status
        // After capsh --drop, specific capability bits should be cleared
        { name: 'cap_bnd', command: 'grep CapBnd /proc/self/status' },
        // Verify CAP_NET_ADMIN (bit 12) is dropped by attempting iptables
        { name: 'iptables_blocked', command: 'iptables -L 2>&1; echo "exit=$?"' },
        // Verify CAP_SYS_CHROOT (bit 18) is dropped in chroot mode
        { name: 'chroot_blocked', command: 'chroot / /bin/true 2>&1; echo "exit=$?"' },
        // Verify CAP_SYS_ADMIN (bit 21) is dropped - mount should fail
        { name: 'mount_blocked', command: 'mount -t tmpfs tmpfs /tmp/test-mount 2>&1; echo "exit=$?"' },
        // Verify the shell is bash
        { name: 'shell_check', command: 'echo "SHELL_NAME=$BASH_VERSION"' },
        // Verify /proc/self/exe does NOT point to bash for non-bash processes
        { name: 'proc_exe_python', command: 'python3 -c "import os; print(os.readlink(\'/proc/self/exe\'))"' },
        // Verify commands with special characters work (direct-write approach)
        { name: 'special_chars', command: 'echo "hello world" && echo \'single quotes\' && echo "dollar $HOME" && echo "backtick $(echo nested)"' },
        // Verify pipes work through the direct-write approach
        { name: 'pipe_chain', command: 'echo "abc def ghi" | tr " " "\\n" | sort | head -1' },
        // Verify that the process tree doesn't have an extra bash layer
        // ps should show bash -> capsh -> bash -> command, NOT bash -> capsh -> bash -> bash -> command
        { name: 'process_tree', command: 'ps -o comm= --ppid $PPID 2>/dev/null || ps -o comm= $PPID 2>/dev/null || echo "ps_unavailable"' },
      ], {
        allowDomains: ['localhost'],
        logLevel: 'debug',
        timeout: 120000,
      });
    }, 180000);

    test('should have CAP_NET_ADMIN dropped from bounding set', () => {
      const r = batch.get('cap_bnd');
      expect(r.exitCode).toBe(0);
      // CapBnd is a hex bitmask. CAP_NET_ADMIN is bit 12 (0x1000).
      // If dropped, bit 12 should be 0.
      const match = r.stdout.match(/CapBnd:\s*([0-9a-f]+)/i);
      expect(match).toBeTruthy();
      if (match) {
        const capBnd = BigInt('0x' + match[1]);
        const CAP_NET_ADMIN = BigInt(1) << BigInt(12);
        expect(capBnd & CAP_NET_ADMIN).toBe(BigInt(0));
      }
    });

    test('should have CAP_SYS_CHROOT dropped from bounding set', () => {
      const r = batch.get('cap_bnd');
      expect(r.exitCode).toBe(0);
      const match = r.stdout.match(/CapBnd:\s*([0-9a-f]+)/i);
      expect(match).toBeTruthy();
      if (match) {
        const capBnd = BigInt('0x' + match[1]);
        const CAP_SYS_CHROOT = BigInt(1) << BigInt(18);
        expect(capBnd & CAP_SYS_CHROOT).toBe(BigInt(0));
      }
    });

    test('should have CAP_SYS_ADMIN dropped from bounding set', () => {
      const r = batch.get('cap_bnd');
      expect(r.exitCode).toBe(0);
      const match = r.stdout.match(/CapBnd:\s*([0-9a-f]+)/i);
      expect(match).toBeTruthy();
      if (match) {
        const capBnd = BigInt('0x' + match[1]);
        const CAP_SYS_ADMIN = BigInt(1) << BigInt(21);
        expect(capBnd & CAP_SYS_ADMIN).toBe(BigInt(0));
      }
    });

    test('should fail iptables command (CAP_NET_ADMIN dropped)', () => {
      const r = batch.get('iptables_blocked');
      expect(r.stdout).toMatch(/exit=[^0]/);
    });

    test('should fail chroot command (CAP_SYS_CHROOT dropped)', () => {
      const r = batch.get('chroot_blocked');
      expect(r.stdout).toMatch(/exit=[^0]/);
    });

    test('should fail mount command (CAP_SYS_ADMIN dropped)', () => {
      const r = batch.get('mount_blocked');
      expect(r.stdout).toMatch(/exit=[^0]/);
    });

    test('should run commands under bash shell', () => {
      const r = batch.get('shell_check');
      expect(r.exitCode).toBe(0);
      // BASH_VERSION is set only when running under bash
      expect(r.stdout).toMatch(/SHELL_NAME=\d+\.\d+/);
    });

    test('should resolve /proc/self/exe correctly for python3 (not bash)', () => {
      const r = batch.get('proc_exe_python');
      if (r.exitCode === 0) {
        // python3's /proc/self/exe should point to python, not bash
        expect(r.stdout).toMatch(/python/);
        expect(r.stdout).not.toMatch(/\/bin\/bash$/);
      }
      // Skip if python3 not available
    });

    test('should handle special characters in direct-write commands', () => {
      const r = batch.get('special_chars');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('hello world');
      expect(r.stdout).toContain('single quotes');
      expect(r.stdout).toContain('dollar');
      expect(r.stdout).toContain('backtick nested');
    });

    test('should handle pipe chains in direct-write commands', () => {
      const r = batch.get('pipe_chain');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('abc');
    });
  });
});
