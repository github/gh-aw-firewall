/**
 * Shared test harness for config-writer suites.
 *
 * Shared jest.mock() registration lives in
 * config-writer-dependency-mocks.test-utils.ts.
 *
 * This file provides the mock factories and lifecycle helpers consumed by
 * that module and by the config-writer test suites.
 *
 * The buildWriteConfig, setupConfigWriterTempDir, and cleanupConfigWriterTempDir
 * helpers eliminate the duplicated factory and lifecycle code that was previously
 * repeated verbatim across config-writer.test.ts and config-writer-branches.test.ts.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getRealUserHome } from '../host-identity';
import type { WrapperConfig } from '../types';

// ─── Mock factories ──────────────────────────────────────────────────────────

/** Factory for jest.mock('./ssl-bump', …) */
export function sslBumpMockFactory() {
  return {
    isOpenSslAvailable: jest.fn(),
    generateSessionCa: jest.fn(),
    initSslDb: jest.fn(),
  };
}

/** Factory for jest.mock('./domain-matchers', …) */
export function domainMatchersMockFactory() {
  return {
    parseUrlPatterns: jest.fn().mockReturnValue([]),
  };
}

/** Factory for jest.mock('./squid-config', …) */
export function squidConfigMockFactory() {
  return {
    generateSquidConfig: jest.fn().mockReturnValue('# mock squid config'),
    generatePolicyManifest: jest.fn().mockReturnValue({}),
  };
}

/** Factory for jest.mock('./compose-generator', …) */
export function composeGeneratorMockFactory() {
  return {
    generateDockerCompose: jest.fn().mockReturnValue({ services: {}, version: '3' }),
    redactDockerComposeSecrets: jest.fn().mockReturnValue({ services: {}, version: '3' }),
  };
}

// ─── Config factory ──────────────────────────────────────────────────────────

/** Builds a minimal valid WrapperConfig for config-writer tests. */
export function buildWriteConfig(
  tempDir: string,
  overrides: Partial<WrapperConfig> = {}
): WrapperConfig {
  return {
    workDir: tempDir,
    sslBump: false,
    allowedDomains: [],
    agentCommand: 'echo test',
    logLevel: 'info',
    keepContainers: false,
    buildLocal: false,
    imageRegistry: 'ghcr.io/github/gh-aw-firewall',
    imageTag: 'latest',
    ...overrides,
  };
}

// ─── Temp-dir lifecycle ──────────────────────────────────────────────────────

/**
 * Creates a fresh temp directory for a config-writer test, clears all mocks,
 * and wires up the standard chownSync / getRealUserHome stubs.
 * Call from beforeEach; the returned path is the workDir for that test run.
 */
export function setupConfigWriterTempDir(prefix = 'config-writer-test-'): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  jest.clearAllMocks();
  (fs.chownSync as unknown as jest.Mock).mockImplementation(() => undefined);
  (getRealUserHome as jest.Mock).mockReturnValue(tempDir);
  return tempDir;
}

/**
 * Removes the temp directory and the chroot-home sibling that writeConfigs
 * creates alongside it.  Call from afterEach.
 */
export function cleanupConfigWriterTempDir(tempDir: string): void {
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.rmSync(`${tempDir}-chroot-home`, { recursive: true, force: true });
}
