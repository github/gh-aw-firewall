import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { validateWithSchema } from './schema-validator';

/** @internal Used only by config-file helpers — not part of public API */
// ts-prune-ignore-next
export interface AwfFileConfig {
  $schema?: string;
  network?: {
    allowDomains?: string[];
    blockDomains?: string[];
    dnsServers?: string[];
    upstreamProxy?: string;
    isolation?: boolean;
    topologyAttach?: string[];
  };
  apiProxy?: {
    enabled?: boolean;
    enableTokenSteering?: boolean;
    anthropicAutoCache?: boolean;
    anthropicCacheTailTtl?: string;
    maxEffectiveTokens?: number;
    maxAiCredits?: number;
    defaultAiCreditsPricing?: { input: number; output: number; cachedInput?: number; cacheWrite?: number | null };
    modelMultipliers?: Record<string, number>;
    defaultModelMultiplier?: number;
    maxModelMultiplierCap?: number;
    maxTurns?: number;
    /** @deprecated Use maxTurns instead */
    maxRuns?: number;
    maxPermissionDenied?: number;
    maxCacheMisses?: number;
    requestedModel?: string;
    modelFallback?: {
      enabled?: boolean;
      strategy?: 'middle_power';
      excludeEngines?: string[];
    };
    modelRouter?: {
      providerType?: string;
      baseUrl?: string;
    };
    targets?: {
      openai?: { host?: string; basePath?: string; authHeader?: string };
      anthropic?: { host?: string; basePath?: string; authHeader?: string };
      copilot?: {
        host?: string;
        basePath?: string;
        extraHeaders?: Record<string, string>;
        extraBodyFields?: Record<string, string>;
        sessionId?: string;
      };
      gemini?: { host?: string; basePath?: string };
      antigravity?: { host?: string; basePath?: string };
    };
    models?: Record<string, string[]>;
    allowedModels?: string[];
    disallowedModels?: string[];
    logging?: {
      debugTokens?: boolean;
      tokenLogDir?: string;
    };
    diagnostics?: {
      captureBlockedRequests?: boolean | 'summary' | 'redacted' | 'full';
      maxCapturedBytes?: number;
    };
    auth?: {
      type?: string;
      provider?: string;
      oidcAudience?: string;
      azureTenantId?: string;
      azureClientId?: string;
      azureScope?: string;
      azureCloud?: string;
      awsRoleArn?: string;
      awsRegion?: string;
      awsRoleSessionName?: string;
      gcpWorkloadIdentityProvider?: string;
      gcpServiceAccount?: string;
      gcpScope?: string;
      anthropicFederationRuleId?: string;
      anthropicOrganizationId?: string;
      anthropicServiceAccountId?: string;
      anthropicWorkspaceId?: string;
      anthropicTokenUrl?: string;
    };
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
    dockerHostPathPrefix?: string;
    runnerToolCachePath?: string;
  };
  chroot?: {
    binariesSourcePath?: string;
    identity?: {
      home?: string;
      user?: string;
      uid?: number;
      gid?: number;
    };
  };
  dind?: {
    preStageDirs?: boolean;
    workDir?: string;
    stagingImage?: string;
    stageEngineBinary?: {
      path?: string;
      targetPath?: string;
    };
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
  platform?: {
    type?: 'github.com' | 'ghes' | 'ghec' | 'ghec-self-hosted';
  };
  runner?: {
    topology?: 'standard' | 'arc-dind';
    sysrootImage?: string;
  };
}

/**
 * Validate an unknown value against the AWF config schema.
 * Returns an array of human-readable error strings (empty = valid).
 *
 * Uses the published JSON Schema (awf-config-schema.json) via ajv for
 * validation, ensuring the schema is the single source of truth for both
 * external consumers (gh-aw compiler) and internal validation.
 * @internal Exposed only for unit tests — not part of the public API.
 */
// ts-prune-ignore-next
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
