#!/usr/bin/env node
'use strict';

/**
 * Executable primary-sbx ingress proof used by runtime-matrix reporting.
 *
 * This intentionally proves only the Unix-socket passthrough path. The
 * authenticated HTTP path requires a live run-specific broker and is proven by
 * main-action before the primary agent starts; a standalone report cannot
 * safely synthesize that capability.
 */
async function main() {
  const { probeSbxUnixSocketMount } = require('../../dist/sbx-manager.js');
  if (!(await probeSbxUnixSocketMount())) {
    process.stderr.write('BLOCKED: primary sbx Unix-socket ingress was not proven\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write('SUPPORTED: primary sbx Unix-socket ingress proven\n');
}

main().catch(() => {
  process.stderr.write('BLOCKED: primary sbx ingress capability probe failed\n');
  process.exitCode = 1;
});
