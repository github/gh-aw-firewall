import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

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
    targets?: {
      openai?: { host?: string; basePath?: string };
      anthropic?: { host?: string; basePath?: string };
      copilot?: { host?: string; basePath?: string };
      gemini?: { host?: string; basePath?: string };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateKnownKeys(
  value: Record<string, unknown>,
  keys: string[],
  location: string,
  errors: string[]
): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      errors.push(`${location}.${key} is not supported`);
    }
  }
}

function validateStringArray(value: unknown, location: string, errors: string[]): void {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    errors.push(`${location} must be an array of strings`);
  }
}

function validateStringOrStringArray(value: unknown, location: string, errors: string[]): void {
  const isValid = typeof value === 'string' || (Array.isArray(value) && value.every(item => typeof item === 'string'));
  if (!isValid) {
    errors.push(`${location} must be a string or array of strings`);
  }
}

function validateProviderTarget(value: unknown, location: string, errors: string[], allowBasePath = true): void {
  if (!isRecord(value)) {
    errors.push(`${location} must be an object`);
    return;
  }
  validateKnownKeys(value, allowBasePath ? ['host', 'basePath'] : ['host'], location, errors);
  if (value.host !== undefined && typeof value.host !== 'string') {
    errors.push(`${location}.host must be a string`);
  }
  if (allowBasePath && value.basePath !== undefined && typeof value.basePath !== 'string') {
    errors.push(`${location}.basePath must be a string`);
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export function validateAwfFileConfig(config: unknown): string[] {
  const errors: string[] = [];

  if (!isRecord(config)) {
    return ['config root must be an object'];
  }

  validateKnownKeys(
    config,
    ['$schema', 'network', 'apiProxy', 'security', 'container', 'environment', 'logging', 'rateLimiting'],
    'config',
    errors
  );

  if (config.$schema !== undefined && typeof config.$schema !== 'string') {
    errors.push('config.$schema must be a string');
  }

  if (config.network !== undefined) {
    if (!isRecord(config.network)) {
      errors.push('config.network must be an object');
    } else {
      validateKnownKeys(config.network, ['allowDomains', 'blockDomains', 'dnsServers', 'upstreamProxy'], 'config.network', errors);
      if (config.network.allowDomains !== undefined) validateStringArray(config.network.allowDomains, 'config.network.allowDomains', errors);
      if (config.network.blockDomains !== undefined) validateStringArray(config.network.blockDomains, 'config.network.blockDomains', errors);
      if (config.network.dnsServers !== undefined) validateStringArray(config.network.dnsServers, 'config.network.dnsServers', errors);
      if (config.network.upstreamProxy !== undefined && typeof config.network.upstreamProxy !== 'string') {
        errors.push('config.network.upstreamProxy must be a string');
      }
    }
  }

  if (config.apiProxy !== undefined) {
    if (!isRecord(config.apiProxy)) {
      errors.push('config.apiProxy must be an object');
    } else {
      validateKnownKeys(config.apiProxy, ['enabled', 'targets'], 'config.apiProxy', errors);
      if (config.apiProxy.enabled !== undefined && typeof config.apiProxy.enabled !== 'boolean') {
        errors.push('config.apiProxy.enabled must be a boolean');
      }
      if (config.apiProxy.targets !== undefined) {
        if (!isRecord(config.apiProxy.targets)) {
          errors.push('config.apiProxy.targets must be an object');
        } else {
          validateKnownKeys(config.apiProxy.targets, ['openai', 'anthropic', 'copilot', 'gemini'], 'config.apiProxy.targets', errors);
          if (config.apiProxy.targets.openai !== undefined) validateProviderTarget(config.apiProxy.targets.openai, 'config.apiProxy.targets.openai', errors);
          if (config.apiProxy.targets.anthropic !== undefined) validateProviderTarget(config.apiProxy.targets.anthropic, 'config.apiProxy.targets.anthropic', errors);
          if (config.apiProxy.targets.copilot !== undefined) validateProviderTarget(config.apiProxy.targets.copilot, 'config.apiProxy.targets.copilot', errors, false);
          if (config.apiProxy.targets.gemini !== undefined) validateProviderTarget(config.apiProxy.targets.gemini, 'config.apiProxy.targets.gemini', errors);
        }
      }
    }
  }

  if (config.security !== undefined) {
    if (!isRecord(config.security)) {
      errors.push('config.security must be an object');
    } else {
      validateKnownKeys(
        config.security,
        ['sslBump', 'enableDlp', 'enableHostAccess', 'allowHostPorts', 'allowHostServicePorts', 'difcProxy'],
        'config.security',
        errors
      );
      if (config.security.sslBump !== undefined && typeof config.security.sslBump !== 'boolean') errors.push('config.security.sslBump must be a boolean');
      if (config.security.enableDlp !== undefined && typeof config.security.enableDlp !== 'boolean') errors.push('config.security.enableDlp must be a boolean');
      if (config.security.enableHostAccess !== undefined && typeof config.security.enableHostAccess !== 'boolean') errors.push('config.security.enableHostAccess must be a boolean');
      if (config.security.allowHostPorts !== undefined) validateStringOrStringArray(config.security.allowHostPorts, 'config.security.allowHostPorts', errors);
      if (config.security.allowHostServicePorts !== undefined) validateStringOrStringArray(config.security.allowHostServicePorts, 'config.security.allowHostServicePorts', errors);
      if (config.security.difcProxy !== undefined) {
        if (!isRecord(config.security.difcProxy)) {
          errors.push('config.security.difcProxy must be an object');
        } else {
          validateKnownKeys(config.security.difcProxy, ['host', 'caCert'], 'config.security.difcProxy', errors);
          if (config.security.difcProxy.host !== undefined && typeof config.security.difcProxy.host !== 'string') errors.push('config.security.difcProxy.host must be a string');
          if (config.security.difcProxy.caCert !== undefined && typeof config.security.difcProxy.caCert !== 'string') errors.push('config.security.difcProxy.caCert must be a string');
        }
      }
    }
  }

  if (config.container !== undefined) {
    if (!isRecord(config.container)) {
      errors.push('config.container must be an object');
    } else {
      validateKnownKeys(
        config.container,
        ['memoryLimit', 'agentTimeout', 'enableDind', 'workDir', 'containerWorkDir', 'imageRegistry', 'imageTag', 'skipPull', 'buildLocal', 'agentImage', 'tty', 'dockerHost'],
        'config.container',
        errors
      );
      if (config.container.memoryLimit !== undefined && typeof config.container.memoryLimit !== 'string') errors.push('config.container.memoryLimit must be a string');
      if (config.container.agentTimeout !== undefined && !isPositiveInteger(config.container.agentTimeout)) {
        errors.push('config.container.agentTimeout must be a positive integer');
      }
      if (config.container.enableDind !== undefined && typeof config.container.enableDind !== 'boolean') errors.push('config.container.enableDind must be a boolean');
      if (config.container.workDir !== undefined && typeof config.container.workDir !== 'string') errors.push('config.container.workDir must be a string');
      if (config.container.containerWorkDir !== undefined && typeof config.container.containerWorkDir !== 'string') errors.push('config.container.containerWorkDir must be a string');
      if (config.container.imageRegistry !== undefined && typeof config.container.imageRegistry !== 'string') errors.push('config.container.imageRegistry must be a string');
      if (config.container.imageTag !== undefined && typeof config.container.imageTag !== 'string') errors.push('config.container.imageTag must be a string');
      if (config.container.skipPull !== undefined && typeof config.container.skipPull !== 'boolean') errors.push('config.container.skipPull must be a boolean');
      if (config.container.buildLocal !== undefined && typeof config.container.buildLocal !== 'boolean') errors.push('config.container.buildLocal must be a boolean');
      if (config.container.agentImage !== undefined && typeof config.container.agentImage !== 'string') errors.push('config.container.agentImage must be a string');
      if (config.container.tty !== undefined && typeof config.container.tty !== 'boolean') errors.push('config.container.tty must be a boolean');
      if (config.container.dockerHost !== undefined && typeof config.container.dockerHost !== 'string') errors.push('config.container.dockerHost must be a string');
    }
  }

  if (config.environment !== undefined) {
    if (!isRecord(config.environment)) {
      errors.push('config.environment must be an object');
    } else {
      validateKnownKeys(config.environment, ['envFile', 'envAll', 'excludeEnv'], 'config.environment', errors);
      if (config.environment.envFile !== undefined && typeof config.environment.envFile !== 'string') errors.push('config.environment.envFile must be a string');
      if (config.environment.envAll !== undefined && typeof config.environment.envAll !== 'boolean') errors.push('config.environment.envAll must be a boolean');
      if (config.environment.excludeEnv !== undefined) validateStringArray(config.environment.excludeEnv, 'config.environment.excludeEnv', errors);
    }
  }

  if (config.logging !== undefined) {
    if (!isRecord(config.logging)) {
      errors.push('config.logging must be an object');
    } else {
      validateKnownKeys(config.logging, ['logLevel', 'diagnosticLogs', 'auditDir', 'proxyLogsDir', 'sessionStateDir'], 'config.logging', errors);
      if (config.logging.logLevel !== undefined && (typeof config.logging.logLevel !== 'string' || !['debug', 'info', 'warn', 'error'].includes(config.logging.logLevel))) {
        errors.push('config.logging.logLevel must be one of: debug, info, warn, error');
      }
      if (config.logging.diagnosticLogs !== undefined && typeof config.logging.diagnosticLogs !== 'boolean') errors.push('config.logging.diagnosticLogs must be a boolean');
      if (config.logging.auditDir !== undefined && typeof config.logging.auditDir !== 'string') errors.push('config.logging.auditDir must be a string');
      if (config.logging.proxyLogsDir !== undefined && typeof config.logging.proxyLogsDir !== 'string') errors.push('config.logging.proxyLogsDir must be a string');
      if (config.logging.sessionStateDir !== undefined && typeof config.logging.sessionStateDir !== 'string') errors.push('config.logging.sessionStateDir must be a string');
    }
  }

  if (config.rateLimiting !== undefined) {
    if (!isRecord(config.rateLimiting)) {
      errors.push('config.rateLimiting must be an object');
    } else {
      validateKnownKeys(config.rateLimiting, ['enabled', 'requestsPerMinute', 'requestsPerHour', 'bytesPerMinute'], 'config.rateLimiting', errors);
      if (config.rateLimiting.enabled !== undefined && typeof config.rateLimiting.enabled !== 'boolean') errors.push('config.rateLimiting.enabled must be a boolean');
      if (config.rateLimiting.requestsPerMinute !== undefined && !isPositiveInteger(config.rateLimiting.requestsPerMinute)) {
        errors.push('config.rateLimiting.requestsPerMinute must be a positive integer');
      }
      if (config.rateLimiting.requestsPerHour !== undefined && !isPositiveInteger(config.rateLimiting.requestsPerHour)) {
        errors.push('config.rateLimiting.requestsPerHour must be a positive integer');
      }
      if (config.rateLimiting.bytesPerMinute !== undefined && !isPositiveInteger(config.rateLimiting.bytesPerMinute)) {
        errors.push('config.rateLimiting.bytesPerMinute must be a positive integer');
      }
    }
  }

  return errors;
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
    openaiApiTarget: config.apiProxy?.targets?.openai?.host,
    openaiApiBasePath: config.apiProxy?.targets?.openai?.basePath,
    anthropicApiTarget: config.apiProxy?.targets?.anthropic?.host,
    anthropicApiBasePath: config.apiProxy?.targets?.anthropic?.basePath,
    copilotApiTarget: config.apiProxy?.targets?.copilot?.host,
    geminiApiTarget: config.apiProxy?.targets?.gemini?.host,
    geminiApiBasePath: config.apiProxy?.targets?.gemini?.basePath,

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
