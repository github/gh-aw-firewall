#!/usr/bin/env node

/**
 * Generates the JSON Schema for the AWF config file.
 *
 * Usage:
 *   node scripts/generate-schema.mjs                          # writes docs/awf-config.schema.json and docs/awf-config.v1.schema.json
 *   node scripts/generate-schema.mjs --version v0.23.1        # embeds a versioned $id in release output
 *   node scripts/generate-schema.mjs --print                  # prints to stdout
 *
 * Output files:
 *   docs/awf-config.v1.schema.json  — stable versioned file (canonical source)
 *   docs/awf-config.schema.json     — latest alias (always points to current version content)
 *   src/awf-config-schema.json      — bundleable copy for runtime validation
 *
 * The schema reflects the validated config surface defined in src/config-file.ts
 * (validateAwfFileConfig), not just the AwfFileConfig TypeScript interface.
 * When validation rules change (e.g. new fields, enum constraints), update this script to match.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

// --- Parse CLI args ---
const args = process.argv.slice(2);

const knownFlags = new Set(['--version', '--print']);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (!knownFlags.has(arg)) {
    // Skip the value that follows --version
    if (args[i - 1] === '--version') continue;
    console.error(`Error: unknown argument '${arg}'`);
    console.error('Usage: generate-schema.mjs [--version <vX.Y.Z>] [--print]');
    process.exit(1);
  }
}

const versionIdx = args.indexOf('--version');
if (versionIdx !== -1 && (versionIdx + 1 >= args.length || args[versionIdx + 1].startsWith('--'))) {
  console.error('Error: --version requires a value (e.g. --version v0.23.1)');
  console.error('Usage: generate-schema.mjs [--version <vX.Y.Z>] [--print]');
  process.exit(1);
}
const version = versionIdx !== -1 ? args[versionIdx + 1] : null;
const printOnly = args.includes('--print');

// --- Build the schema ---
// Versioned $id (stable reference for v1 of the config schema)
const schemaV1Id = version
  ? `https://github.com/github/gh-aw-firewall/releases/download/${version}/awf-config.v1.schema.json`
  : 'https://raw.githubusercontent.com/github/gh-aw-firewall/main/docs/awf-config.v1.schema.json';

// Unversioned "latest" $id (always points to the current schema)
const schemaLatestId = version
  ? `https://github.com/github/gh-aw-firewall/releases/download/${version}/awf-config.schema.json`
  : 'https://raw.githubusercontent.com/github/gh-aw-firewall/main/docs/awf-config.schema.json';

/** @type {object} */
const schemaBody = {
  title: 'AWF Configuration',
  version: '1',
  description:
    'JSON/YAML configuration for awf CLI. CLI flags override config file values. ' +
    'See https://github.com/github/gh-aw-firewall for documentation.',
  type: 'object',
  additionalProperties: false,
  properties: {
    $schema: {
      type: 'string',
      description: 'JSON Schema URL for IDE validation and autocomplete.',
    },
    network: {
      type: 'object',
      description: 'Network egress configuration.',
      additionalProperties: false,
      properties: {
        allowDomains: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Domains that the agent is allowed to reach. ' +
            'Both the bare domain and all subdomains are permitted (e.g. "github.com" also allows "api.github.com").',
        },
        blockDomains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Domains that are explicitly blocked, overriding allowDomains.',
        },
        dnsServers: {
          type: 'array',
          items: { type: 'string' },
          description:
            'DNS servers to use inside the container. Defaults to Google DNS (8.8.8.8, 8.8.4.4). ' +
            'Accepts IPv4 and IPv6 addresses.',
        },
        upstreamProxy: {
          type: 'string',
          description:
            'Upstream HTTP proxy URL (e.g. "http://proxy.corp.example.com:8080"). ' +
            'When set, the AWF Squid proxy forwards traffic through this proxy.',
        },
      },
    },
    apiProxy: {
      type: 'object',
      description:
        'API proxy sidecar configuration. The sidecar injects real API credentials ' +
        'so the agent never has direct access to them.',
      additionalProperties: false,
      properties: {
        enabled: {
          type: 'boolean',
          description: 'Enable the API proxy sidecar container.',
        },
        enableOpenCode: {
          type: 'boolean',
          description: 'Enable the OpenCode API proxy endpoint (port 10004).',
        },
        anthropicAutoCache: {
          type: 'boolean',
          description:
            'Automatically apply Anthropic prompt-cache optimizations on /v1/messages requests.',
        },
        anthropicCacheTailTtl: {
          type: 'string',
          enum: ['5m', '1h'],
          description:
            'TTL for Anthropic cache tail optimization. ' +
            'Only applies when anthropicAutoCache is enabled. Allowed values: "5m" or "1h".',
        },
        targets: {
          type: 'object',
          description: 'Override upstream API endpoints for each provider.',
          additionalProperties: false,
          properties: {
            openai: {
              $ref: '#/$defs/providerTarget',
              description: 'OpenAI API target override.',
            },
            anthropic: {
              $ref: '#/$defs/providerTarget',
              description: 'Anthropic API target override.',
            },
            copilot: {
              $ref: '#/$defs/providerHostOnlyTarget',
              description: 'GitHub Copilot API target override (basePath not supported).',
            },
            gemini: {
              $ref: '#/$defs/providerTarget',
              description: 'Google Gemini API target override.',
            },
          },
        },
        models: {
          type: 'object',
          description:
            'Model alias mapping. Keys are canonical model names; values are arrays of ' +
            'alternative names or patterns that should be rewritten to the canonical name.',
          additionalProperties: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
    },
    security: {
      type: 'object',
      description: 'Security and isolation configuration.',
      additionalProperties: false,
      properties: {
        sslBump: {
          type: 'boolean',
          description:
            'Enable SSL bumping (TLS interception) in the Squid proxy. ' +
            'Requires a custom CA certificate.',
        },
        enableDlp: {
          type: 'boolean',
          description: 'Enable Data Loss Prevention (DLP) inspection of outbound traffic.',
        },
        enableHostAccess: {
          type: 'boolean',
          description:
            'Mount the host filesystem (read-only for system paths, read-write for the workspace). ' +
            'Enabled by default; set to false to run without host filesystem access.',
        },
        allowHostPorts: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
          description:
            'Host TCP ports the agent may connect to (e.g. local dev services). ' +
            'Accepts a single port string or an array of port strings.',
        },
        allowHostServicePorts: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } },
          ],
          description:
            'Named service ports on the host that the agent may connect to. ' +
            'Accepts a single port string or an array of port strings.',
        },
        difcProxy: {
          type: 'object',
          description: 'DIFC (Data-in-Flight Control) proxy configuration.',
          additionalProperties: false,
          properties: {
            host: {
              type: 'string',
              description: 'DIFC proxy host.',
            },
            caCert: {
              type: 'string',
              description: 'Path to the CA certificate for DIFC proxy TLS verification.',
            },
          },
        },
      },
    },
    container: {
      type: 'object',
      description: 'Container and Docker configuration.',
      additionalProperties: false,
      properties: {
        memoryLimit: {
          type: 'string',
          description:
            'Docker memory limit for the agent container (e.g. "4g", "512m"). ' +
            'Uses Docker memory limit syntax.',
        },
        agentTimeout: {
          type: 'integer',
          minimum: 1,
          description: 'Maximum time (in minutes) the agent command is allowed to run.',
        },
        enableDind: {
          type: 'boolean',
          description: 'Enable Docker-in-Docker support inside the agent container.',
        },
        workDir: {
          type: 'string',
          description:
            'Host path used as the AWF working directory for generated configs and logs. ' +
            'Defaults to a temporary directory.',
        },
        containerWorkDir: {
          type: 'string',
          description: 'Working directory inside the agent container.',
        },
        imageRegistry: {
          type: 'string',
          description:
            'Container image registry to pull from. ' +
            'Defaults to "ghcr.io/github/gh-aw-firewall".',
        },
        imageTag: {
          type: 'string',
          description: 'Container image tag to use. Defaults to "latest".',
        },
        skipPull: {
          type: 'boolean',
          description: 'Skip pulling container images (use locally cached images).',
        },
        buildLocal: {
          type: 'boolean',
          description: 'Build container images from source instead of pulling from the registry.',
        },
        agentImage: {
          type: 'string',
          description:
            'Override the agent container image (e.g. for a GitHub Actions parity image).',
        },
        tty: {
          type: 'boolean',
          description: 'Allocate a pseudo-TTY for the agent container.',
        },
        dockerHost: {
          type: 'string',
          description:
            'Docker daemon socket or host to connect to (e.g. "unix:///var/run/docker.sock").',
        },
      },
    },
    environment: {
      type: 'object',
      description: 'Environment variable propagation into the agent container.',
      additionalProperties: false,
      properties: {
        envFile: {
          type: 'string',
          description:
            'Path to a .env file whose variables are injected into the agent container.',
        },
        envAll: {
          type: 'boolean',
          description:
            'Forward all host environment variables into the agent container. ' +
            'Use with caution — may expose secrets.',
        },
        excludeEnv: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Environment variable names to exclude when envAll is true.',
        },
      },
    },
    logging: {
      type: 'object',
      description: 'Logging and diagnostics configuration.',
      additionalProperties: false,
      properties: {
        logLevel: {
          type: 'string',
          enum: ['debug', 'info', 'warn', 'error'],
          description: 'Log verbosity level. Defaults to "info".',
        },
        diagnosticLogs: {
          type: 'boolean',
          description:
            'Enable diagnostic logging (Squid access logs, iptables logs). ' +
            'Logs are written to the work directory.',
        },
        auditDir: {
          type: 'string',
          description: 'Directory path for audit logs.',
        },
        proxyLogsDir: {
          type: 'string',
          description: 'Directory path for Squid proxy access logs.',
        },
        sessionStateDir: {
          type: 'string',
          description:
            'Directory path for agent session state (e.g. conversation history). ' +
            'Set to "/tmp/gh-aw/sandbox/agent/session-state" for Copilot agent runs.',
        },
      },
    },
    rateLimiting: {
      type: 'object',
      description: 'Egress rate limiting configuration.',
      additionalProperties: false,
      properties: {
        enabled: {
          type: 'boolean',
          description: 'Enable egress rate limiting.',
        },
        requestsPerMinute: {
          type: 'integer',
          minimum: 1,
          description: 'Maximum number of HTTP requests per minute.',
        },
        requestsPerHour: {
          type: 'integer',
          minimum: 1,
          description: 'Maximum number of HTTP requests per hour.',
        },
        bytesPerMinute: {
          type: 'integer',
          minimum: 1,
          description: 'Maximum number of bytes transferred per minute.',
        },
      },
    },
  },
  $defs: {
    providerTarget: {
      type: 'object',
      description: 'API provider target override.',
      additionalProperties: false,
      properties: {
        host: {
          type: 'string',
          description: 'Override the provider API host.',
        },
        basePath: {
          type: 'string',
          description: 'Override the provider API base path.',
        },
      },
    },
    providerHostOnlyTarget: {
      type: 'object',
      description: 'API provider target override (host only; basePath not supported).',
      additionalProperties: false,
      properties: {
        host: {
          type: 'string',
          description: 'Override the provider API host.',
        },
      },
    },
  },
};

// Compose the versioned schema (stable, canonical) and the latest alias
const schemaV1 = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: schemaV1Id,
  ...schemaBody,
};

const schemaLatest = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: schemaLatestId,
  ...schemaBody,
};

const outputV1 = JSON.stringify(schemaV1, null, 2) + '\n';
const outputLatest = JSON.stringify(schemaLatest, null, 2) + '\n';

if (printOnly) {
  // --print emits the versioned (v1) schema to stdout
  process.stdout.write(outputV1);
} else {
  const docsDir = join(projectRoot, 'docs');
  mkdirSync(docsDir, { recursive: true });

  // Stable versioned file (canonical)
  const v1Path = join(docsDir, 'awf-config.v1.schema.json');
  writeFileSync(v1Path, outputV1);
  console.log(`Schema written to ${v1Path}`);

  // Unversioned "latest" alias
  const latestPath = join(docsDir, 'awf-config.schema.json');
  writeFileSync(latestPath, outputLatest);
  console.log(`Schema written to ${latestPath}`);

  // Also write to src/ for runtime loading (loaded dynamically by schema-validator.ts at startup)
  const srcPath = join(projectRoot, 'src', 'awf-config-schema.json');
  writeFileSync(srcPath, outputV1);
  console.log(`Schema written to ${srcPath}`);
}
