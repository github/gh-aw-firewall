import * as fs from 'fs';
import { logger } from '../../logger';
import { SQUID_DANGEROUS_CHARS } from '../../domain-validation';
import { parseDomains } from '../../domain-utils';
import {
  parseEnvironmentVariables,
  parseVolumeMounts,
} from '../../option-parsers';

/**
 * The result produced by {@link validateAgentOptions}.
 */
export interface AgentOptionsResult {
  additionalEnv: Record<string, string>;
  volumeMounts: string[] | undefined;
  allowedUrls: string[] | undefined;
}

/**
 * Validates agent-runtime options: environment variables, volume mounts, and
 * SSL Bump URL patterns.
 *
 * Covers the following option groups:
 *  - `--env` / `--env-file`
 *  - `--mount`
 *  - `--allow-urls`, `--ssl-bump`
 *  - `--enable-dlp`
 *
 * Calls `process.exit(1)` on any validation failure so the caller always
 * receives a fully-validated result.
 */
export function validateAgentOptions(options: Record<string, unknown>): AgentOptionsResult {
  // --- Environment variables -----------------------------------------------

  // Parse additional environment variables from --env flags
  let additionalEnv: Record<string, string> = {};
  if (options.env && Array.isArray(options.env)) {
    const parsed = parseEnvironmentVariables(options.env as string[]);
    if (!parsed.success) {
      logger.error(
        `Invalid environment variable format: ${parsed.invalidVar} (expected KEY=VALUE)`,
      );
      process.exit(1);
    }
    additionalEnv = parsed.env;
  }

  // Validate --env-file path if provided
  if (options.envFile) {
    if (!fs.existsSync(options.envFile as string)) {
      logger.error(`--env-file: file not found: ${options.envFile}`);
      process.exit(1);
    }
  }

  // --- Volume mounts -------------------------------------------------------

  // Parse and validate volume mounts from --mount flags
  let volumeMounts: string[] | undefined;
  if (options.mount && Array.isArray(options.mount) && (options.mount as string[]).length > 0) {
    const parsed = parseVolumeMounts(options.mount as string[]);
    if (!parsed.success) {
      logger.error(`Invalid volume mount: ${parsed.invalidMount}`);
      logger.error(`Reason: ${parsed.reason}`);
      process.exit(1);
    }
    volumeMounts = parsed.mounts;
    logger.debug(`Parsed ${volumeMounts.length} volume mount(s)`);
  }

  // --- SSL Bump URL patterns -----------------------------------------------

  // Parse --allow-urls for SSL Bump mode
  let allowedUrls: string[] | undefined;
  if (options.allowUrls) {
    allowedUrls = parseDomains(options.allowUrls as string);
    if (allowedUrls.length > 0 && !options.sslBump) {
      logger.error('--allow-urls requires --ssl-bump to be enabled');
      process.exit(1);
    }

    // Validate URL patterns for security
    for (const url of allowedUrls) {
      // URL patterns must start with https://
      if (!url.startsWith('https://')) {
        logger.error(`URL patterns must start with https:// (got: ${url})`);
        logger.error('Use --allow-domains for domain-level filtering without SSL Bump');
        process.exit(1);
      }

      // Reject overly broad patterns that would bypass security
      const dangerousPatterns = [
        /^https:\/\/\*$/, // https://*
        /^https:\/\/\*\.\*$/, // https://*.*
        /^https:\/\/\.\*$/, // https://.*
        /^\.\*$/, // .*
        /^\*$/, // *
        /^https:\/\/[^/]*\*[^/]*$/, // https://*anything* without path
      ];

      for (const pattern of dangerousPatterns) {
        if (pattern.test(url)) {
          logger.error(`URL pattern "${url}" is too broad and would bypass security controls`);
          logger.error(
            'URL patterns must include a specific domain and path, e.g., https://github.com/org/*',
          );
          process.exit(1);
        }
      }

      // Reject characters that could inject Squid config directives or tokens
      if (SQUID_DANGEROUS_CHARS.test(url)) {
        logger.error(
          `URL pattern contains characters unsafe for Squid config: ${JSON.stringify(url)}`,
        );
        logger.error(
          'URL patterns must not contain whitespace, quotes, semicolons, backticks, hash characters, or null bytes.',
        );
        process.exit(1);
      }

      // Ensure pattern has a path component (not just domain)
      const urlWithoutScheme = url.replace(/^https:\/\//, '');
      if (!urlWithoutScheme.includes('/')) {
        logger.error(`URL pattern "${url}" must include a path component`);
        logger.error('For domain-only filtering, use --allow-domains instead');
        logger.error('Example: https://github.com/myorg/* (includes path)');
        process.exit(1);
      }
    }
  }

  // Validate SSL Bump option
  if (options.sslBump) {
    logger.info('SSL Bump mode enabled - HTTPS content inspection will be performed');
    logger.warn('⚠️  SSL Bump intercepts HTTPS traffic. Only use for trusted workloads.');
  }

  // Log DLP mode
  if (options.enableDlp) {
    logger.info('DLP scanning enabled - outbound requests will be scanned for credential patterns');
  }

  return {
    additionalEnv,
    volumeMounts,
    allowedUrls,
  };
}
