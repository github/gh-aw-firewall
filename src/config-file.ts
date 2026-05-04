import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { validateWithSchema } from './schema-validator';

export interface AwfFileConfig {
  $schema?: string;
  network?: {
    allowDomains?: string[];
    blockDomains?: string[];
    dnsServers?: string[];
    upstreamProxy?: string;
  };
  apiProxy?: {
    enabled?: boolean;
    enableOpenCode?: boolean;
    anthropicAutoCache?: boolean;
    anthropicCacheTailTtl?: string;
    targets?: {
      openai?: { host?: string; basePath?: string };
      anthropic?: { host?: string; basePath?: string };
      copilot?: { host?: string; basePath?: string };
      gemini?: { host?: string; basePath?: string };
    };
    models?: Record<string, string[]>;
  };
  security?: {
    sslBump?: boolean;
    enableDlp?: boolean;
    enableHostAccess?: boolean;
    allowHostPorts?: string[] | string;
    allowHostServicePorts?: string[] | string;
    difcProxy?: {
      host?: string;
      caCert?: string;
    };
  };
  container?: {
    memoryLimit?: string;
    agentTimeout?: number;
    enableDind?: boolean;
    workDir?: string;
    containerWorkDir?: string;
    imageRegistry?: string;
    imageTag?: string;
    skipPull?: boolean;
    buildLocal?: boolean;
    agentImage?: string;
    tty?: boolean;
    dockerHost?: string;
  };
  environment?: {
    envFile?: string;
    envAll?: boolean;
    excludeEnv?: string[];
  };
  logging?: {
    logLevel?: 'debug' | 'info' | 'warn' | 'error';
    diagnosticLogs?: boolean;
    auditDir?: string;
    proxyLogsDir?: string;
    sessionStateDir?: string;
  };
  rateLimiting?: {
    enabled?: boolean;
    requestsPerMinute?: number;
    requestsPerHour?: number;
    bytesPerMinute?: number;
  };
}

/**
 * Validate an unknown value against the AWF config schema.
 * Returns an array of human-readable error strings (empty = valid).
 *
 * Uses the published JSON Schema (awf-config-schema.json) via ajv for
 * validation, ensuring the schema is the single source of truth for both
 * external consumers (gh-aw compiler) and internal validation.
 */
export function validateAwfFileConfig(config: unknown): string[] {
  return validateWithSchema(config);
}

const readStdinSync = (): string => fs.readFileSync(process.stdin.fd, 'utf8');

export function loadAwfFileConfig(configPath: string, readStdin: () => string = readStdinSync): AwfFileConfig {
  let rawContent: string;
  let sourceLabel: string;

  if (configPath === '-') {
    rawContent = readStdin();
    sourceLabel = 'stdin';
  } else {
    const resolvedPath = path.resolve(process.cwd(), configPath);
    rawContent = fs.readFileSync(resolvedPath, 'utf8');
    sourceLabel = resolvedPath;
  }

  let parsed: unknown;
  const isJson = configPath.endsWith('.json');
  const isYaml = configPath.endsWith('.yaml') || configPath.endsWith('.yml');
  const isStdin = configPath === '-';

  try {
    if (isJson) {
      parsed = JSON.parse(rawContent);
    } else if (isYaml) {
      parsed = yaml.load(rawContent);
    } else if (isStdin) {
      // stdin intentionally supports both formats; prefer strict JSON parse first.
      try {
        parsed = JSON.parse(rawContent);
      } catch {
        parsed = yaml.load(rawContent);
      }
    } else {
      // For extensionless paths, prefer JSON first (strict) then YAML.
      try {
        parsed = JSON.parse(rawContent);
      } catch {
        parsed = yaml.load(rawContent);
      }
    }
  } catch (error) {
    throw new Error(`Failed to parse AWF config from ${sourceLabel}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const errors = validateAwfFileConfig(parsed);
  if (errors.length > 0) {
    throw new Error(`Invalid AWF config at ${sourceLabel}:\n- ${errors.join('\n- ')}`);
  }

  return parsed as AwfFileConfig;
}

function joinComma(value: string[] | undefined): string | undefined {
  // Empty arrays intentionally map to undefined so they don't override defaults with "".
  if (!value || value.length === 0) return undefined;
  return value.join(',');
}

function joinPorts(value: string[] | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join(',') : value;
}

function toStringIfDefined(value: number | undefined): string | undefined {
  return value !== undefined ? String(value) : undefined;
}

export function mapAwfFileConfigToCliOptions(config: AwfFileConfig): Record<string, unknown> {
  return {
    allowDomains: joinComma(config.network?.allowDomains),
    blockDomains: joinComma(config.network?.blockDomains),
    dnsServers: joinComma(config.network?.dnsServers),
    upstreamProxy: config.network?.upstreamProxy,

    enableApiProxy: config.apiProxy?.enabled,
    enableOpencode: config.apiProxy?.enableOpenCode,
    anthropicAutoCache: config.apiProxy?.anthropicAutoCache,
    anthropicCacheTailTtl: config.apiProxy?.anthropicCacheTailTtl as '5m' | '1h' | undefined,
    openaiApiTarget: config.apiProxy?.targets?.openai?.host,
    openaiApiBasePath: config.apiProxy?.targets?.openai?.basePath,
    anthropicApiTarget: config.apiProxy?.targets?.anthropic?.host,
    anthropicApiBasePath: config.apiProxy?.targets?.anthropic?.basePath,
    copilotApiTarget: config.apiProxy?.targets?.copilot?.host,
    geminiApiTarget: config.apiProxy?.targets?.gemini?.host,
    geminiApiBasePath: config.apiProxy?.targets?.gemini?.basePath,
    modelAliases: config.apiProxy?.models,

    sslBump: config.security?.sslBump,
    enableDlp: config.security?.enableDlp,
    enableHostAccess: config.security?.enableHostAccess,
    allowHostPorts: joinPorts(config.security?.allowHostPorts),
    allowHostServicePorts: joinPorts(config.security?.allowHostServicePorts),
    difcProxyHost: config.security?.difcProxy?.host,
    difcProxyCaCert: config.security?.difcProxy?.caCert,

    memoryLimit: config.container?.memoryLimit,
    agentTimeout: toStringIfDefined(config.container?.agentTimeout),
    enableDind: config.container?.enableDind,
    workDir: config.container?.workDir,
    containerWorkdir: config.container?.containerWorkDir,
    imageRegistry: config.container?.imageRegistry,
    imageTag: config.container?.imageTag,
    skipPull: config.container?.skipPull,
    buildLocal: config.container?.buildLocal,
    agentImage: config.container?.agentImage,
    tty: config.container?.tty,
    dockerHost: config.container?.dockerHost,

    envFile: config.environment?.envFile,
    envAll: config.environment?.envAll,
    excludeEnv: config.environment?.excludeEnv,

    logLevel: config.logging?.logLevel,
    diagnosticLogs: config.logging?.diagnosticLogs,
    auditDir: config.logging?.auditDir,
    proxyLogsDir: config.logging?.proxyLogsDir,
    sessionStateDir: config.logging?.sessionStateDir,

    // CLI has a negated flag (--no-rate-limit). Only explicit false maps to that flag.
    rateLimit: config.rateLimiting?.enabled === false ? false : undefined,
    rateLimitRpm: toStringIfDefined(config.rateLimiting?.requestsPerMinute),
    rateLimitRph: toStringIfDefined(config.rateLimiting?.requestsPerHour),
    rateLimitBytesPm: toStringIfDefined(config.rateLimiting?.bytesPerMinute),
  };
}

export function applyConfigOptionsInPlaceWithCliPrecedence(
  options: Record<string, unknown>,
  configOptions: Record<string, unknown>,
  isCliProvided: (optionName: string) => boolean
): void {
  for (const [key, value] of Object.entries(configOptions)) {
    if (value === undefined) continue;
    if (isCliProvided(key)) continue;
    options[key] = value;
  }
}
