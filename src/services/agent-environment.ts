import * as path from 'path';
import {
  SQUID_PORT,
  MAX_ENV_VALUE_SIZE,
  ENV_SIZE_WARNING_THRESHOLD,
  TOOLCHAIN_ENV_VARS,
  SslConfig,
  getSafeHostUid,
  getSafeHostGid,
  getRealUserHome,
  extractGhHostFromServerUrl,
  readGitHubPathEntries,
  readGitHubEnvEntries,
  mergeGitHubPathEntries,
  readEnvFile,
} from '../host-env';
import { logger } from '../logger';
import { PROXY_ENV_VARS } from '../upstream-proxy';
import { WrapperConfig } from '../types';
import { NetworkConfig } from './squid-service';

// ─── Agent Environment ────────────────────────────────────────────────────────

export interface AgentEnvironmentParams {
  config: WrapperConfig;
  networkConfig: NetworkConfig;
  dnsServers: string[];
  sslConfig?: SslConfig;
}

/**
 * Builds the environment variable map for the agent container.
 * Returns a mutable object; callers (api-proxy, cli-proxy service builders)
 * are expected to merge additional entries into it before finalising the service.
 */
export function buildAgentEnvironment(params: AgentEnvironmentParams): Record<string, string> {
  const { config, networkConfig, dnsServers, sslConfig } = params;

  // System variables that must be overridden or excluded (would break container operation)
  const EXCLUDED_ENV_VARS = new Set([
    'PATH',           // Must use container's PATH
    'PWD',            // Container's working directory
    'OLDPWD',         // Not relevant in container
    'SHLVL',          // Shell level not relevant
    '_',              // Last command executed
    'SUDO_COMMAND',   // Sudo metadata
    'SUDO_USER',      // Sudo metadata
    'SUDO_UID',       // Sudo metadata
    'SUDO_GID',       // Sudo metadata
    // GitHub Actions artifact service tokens — excluded from inherited environment
    // propagation to prevent agents from uploading arbitrary data as workflow artifacts
    // (potential data exfiltration vector). These tokens are only needed by the
    // Actions runner itself, not by the agent.
    'ACTIONS_RUNTIME_TOKEN',
    'ACTIONS_RESULTS_URL',
    // Proxy environment variables — excluded to prevent host proxy settings from
    // conflicting with AWF's internal routing (agent → Squid → internet).
    // AWF sets its own HTTP_PROXY/HTTPS_PROXY pointing to Squid.
    ...PROXY_ENV_VARS,
    // Internal AWF control knobs — must never be inherited from the host environment
    // via --env-all; they are set explicitly by generateDockerCompose when needed.
    'AWF_PREFLIGHT_BINARY',
    'AWF_GEMINI_ENABLED',
  ]);

  // When api-proxy is enabled, exclude API keys from agent environment
  // (they are held securely in the api-proxy sidecar instead)
  if (config.enableApiProxy) {
    EXCLUDED_ENV_VARS.add('OPENAI_API_KEY');
    EXCLUDED_ENV_VARS.add('OPENAI_KEY');
    EXCLUDED_ENV_VARS.add('CODEX_API_KEY');
    EXCLUDED_ENV_VARS.add('ANTHROPIC_API_KEY');
    EXCLUDED_ENV_VARS.add('CLAUDE_API_KEY');
    EXCLUDED_ENV_VARS.add('COPILOT_GITHUB_TOKEN');
    EXCLUDED_ENV_VARS.add('COPILOT_API_KEY');
    EXCLUDED_ENV_VARS.add('COPILOT_PROVIDER_API_KEY');
    EXCLUDED_ENV_VARS.add('GEMINI_API_KEY');
    EXCLUDED_ENV_VARS.add('GOOGLE_GEMINI_BASE_URL');
    EXCLUDED_ENV_VARS.add('GEMINI_API_BASE_URL');
    // Copilot credential vars are excluded from inherited env passthrough. When needed for
    // compatibility, placeholder values are set explicitly below and protected by one-shot-token.
    // GITHUB_API_URL is intentionally NOT excluded: the Copilot CLI needs it to know the
    // GitHub API base URL. Copilot-specific API calls (inference and token exchange) go
    // through COPILOT_API_URL → api-proxy regardless of GITHUB_API_URL being set.
    // See: github/gh-aw#20875
  }

  // When cli-proxy is enabled (external DIFC proxy), exclude GitHub tokens
  // from agent environment. Tokens are held securely by the external DIFC proxy.
  if (config.difcProxyHost) {
    EXCLUDED_ENV_VARS.add('GITHUB_TOKEN');
    EXCLUDED_ENV_VARS.add('GH_TOKEN');
  }

  // Start with required/overridden environment variables
  // Use the real user's home (not /root when running with sudo)
  const homeDir = getRealUserHome();
  const environment: Record<string, string> = {
    HTTP_PROXY: `http://${networkConfig.squidIp}:${SQUID_PORT}`,
    HTTPS_PROXY: `http://${networkConfig.squidIp}:${SQUID_PORT}`,
    // Lowercase https_proxy for tools that only check lowercase (e.g., Yarn 4/undici, Corepack).
    // NOTE: We intentionally do NOT set lowercase http_proxy. Some curl builds (Ubuntu 22.04)
    // ignore uppercase HTTP_PROXY for HTTP URLs (httpoxy mitigation), which means HTTP traffic
    // falls through to iptables DNAT interception — the correct behavior for connection-level
    // blocking. Setting http_proxy would route HTTP through the forward proxy where Squid's
    // 403 error page returns exit code 0, breaking security expectations.
    https_proxy: `http://${networkConfig.squidIp}:${SQUID_PORT}`,
    SQUID_PROXY_HOST: 'squid-proxy',
    SQUID_PROXY_PORT: SQUID_PORT.toString(),
    HOME: homeDir,
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    // Color output control: when --tty is set, enable color output for tools that support it.
    // When tty is off (default), disable colors to avoid ANSI escape codes in log output.
    // NO_COLOR is a standard convention (https://no-color.org/) supported by many libraries.
    // FORCE_COLOR is used by Chalk, Rich, and other tools to enable color output.
    ...(config.tty ? {
      FORCE_COLOR: '1',
      TERM: 'xterm-256color',
      COLUMNS: '120',
    } : {
      NO_COLOR: '1',
    }),
    // Configure one-shot-token library with sensitive tokens to protect
    // These tokens are cached on first access and unset from /proc/self/environ
    AWF_ONE_SHOT_TOKENS: 'COPILOT_GITHUB_TOKEN,GITHUB_TOKEN,GH_TOKEN,GITHUB_API_TOKEN,GITHUB_PAT,GH_ACCESS_TOKEN,OPENAI_API_KEY,OPENAI_KEY,ANTHROPIC_API_KEY,CLAUDE_API_KEY,CODEX_API_KEY,COPILOT_API_KEY,COPILOT_PROVIDER_API_KEY',
  };

  // Copilot CLI requires Node.js. Ask the agent entrypoint to fail fast with a
  // clear diagnostic if node is not reachable inside the chroot before startup.
  const commandExecutable = config.agentCommand.trim().split(/\s+/, 1)[0] || '';
  const commandExecutableBase = path.posix.basename(commandExecutable.replace(/\\/g, '/'));
  const isCopilotCommand = commandExecutableBase.toLowerCase() === 'copilot';
  if (config.copilotGithubToken || config.copilotApiKey || isCopilotCommand) {
    environment.AWF_REQUIRE_NODE = '1';
  }

  // For commands whose binary may be absent on some runner slots (e.g. codex), ask the
  // agent entrypoint to verify the binary exists inside the chroot before exec'ing, so
  // the failure is a clear diagnostic instead of a cryptic shell error.
  const isCodexCommand = commandExecutableBase.toLowerCase() === 'codex';
  if (isCodexCommand) {
    environment.AWF_PREFLIGHT_BINARY = 'codex';
  }

  // When api-proxy is enabled with Copilot, set placeholder tokens early
  // so --env-all won't override them with real values from host environment
  if (config.enableApiProxy && config.copilotGithubToken) {
    environment.COPILOT_GITHUB_TOKEN = 'placeholder-token-for-credential-isolation';
    logger.debug('COPILOT_GITHUB_TOKEN set to placeholder value (early) to prevent --env-all override');
  }
  if (config.enableApiProxy && config.copilotApiKey) {
    environment.COPILOT_API_KEY = 'placeholder-token-for-credential-isolation';
    logger.debug('COPILOT_API_KEY set to placeholder value (early) to prevent --env-all override');
    environment.COPILOT_PROVIDER_API_KEY = 'placeholder-token-for-credential-isolation';
    logger.debug('COPILOT_PROVIDER_API_KEY set to placeholder value (early) to prevent --env-all override');
  }

  // Always set NO_PROXY to prevent HTTP clients from proxying localhost traffic through Squid.
  // Without this, test frameworks that start local servers (e.g., go/echo, python/uvicorn,
  // deno/fresh) get 403 errors because Squid rejects requests to localhost (not in allowed domains).
  // Include the agent's own container IP because test frameworks often bind to 0.0.0.0 and
  // test clients may connect via the container's non-loopback IP (e.g., 172.30.0.20).
  environment.NO_PROXY = `localhost,127.0.0.1,::1,0.0.0.0,${networkConfig.squidIp},${networkConfig.agentIp}`;
  environment.no_proxy = environment.NO_PROXY;

  // When host access is enabled, also bypass the proxy for the host gateway IPs.
  // MCP Streamable HTTP (SSE) traffic through Squid crashes it (comm.cc:1583),
  // so MCP gateway traffic must go directly to the host, not through Squid.
  if (config.enableHostAccess) {
    // Compute the network gateway IP (first usable IP in the subnet)
    const subnetBase = networkConfig.subnet.split('/')[0]; // e.g. "172.30.0.0"
    const parts = subnetBase.split('.');
    const networkGatewayIp = `${parts[0]}.${parts[1]}.${parts[2]}.1`;
    environment.NO_PROXY += `,host.docker.internal,${networkGatewayIp}`;
    environment.no_proxy = environment.NO_PROXY;
  }

  // When API proxy is enabled, bypass HTTP_PROXY for the api-proxy IP
  // so the agent can reach the sidecar directly without going through Squid
  if (config.enableApiProxy && networkConfig.proxyIp) {
    environment.NO_PROXY += `,${networkConfig.proxyIp}`;
    environment.no_proxy = environment.NO_PROXY;
  }

  // Pass the host's actual PATH and tool directories so the entrypoint can use them
  // This ensures toolcache paths (Python, Node, Go, Rust, Java, Ruby, Dart, etc.) are correctly resolved
  //
  // Also merge paths from $GITHUB_PATH file. When setup-* actions (setup-ruby, setup-dart,
  // setup-python, etc.) run before AWF, they write tool paths to this file. The Actions
  // runner normally prepends these to $PATH, but sudo may reset PATH, losing them.
  // Reading the file directly ensures these paths are always included.
  if (process.env.PATH) {
    const githubPathEntries = readGitHubPathEntries();
    environment.AWF_HOST_PATH = mergeGitHubPathEntries(process.env.PATH, githubPathEntries);
    if (githubPathEntries.length > 0) {
      logger.debug(`Merged ${githubPathEntries.length} path(s) from $GITHUB_PATH into AWF_HOST_PATH`);
    }
  }
  // Toolchain variables (GOROOT, CARGO_HOME, JAVA_HOME, etc.) set by setup-* actions.
  // When AWF runs via sudo, these may be stripped from process.env. Fall back to
  // reading $GITHUB_ENV file directly (analogous to readGitHubPathEntries for $GITHUB_PATH).
  const runningUnderSudo =
    process.getuid?.() === 0 && (Boolean(process.env.SUDO_UID) || Boolean(process.env.SUDO_USER));
  const githubEnvEntries = runningUnderSudo ? readGitHubEnvEntries() : {};
  for (const varName of TOOLCHAIN_ENV_VARS) {
    const value = process.env[varName] || (runningUnderSudo ? githubEnvEntries[varName] : undefined);
    if (value) {
      environment[`AWF_${varName}`] = value;
      if (!process.env[varName] && runningUnderSudo && githubEnvEntries[varName]) {
        logger.debug(`Recovered ${varName} from $GITHUB_ENV (sudo likely stripped it from process.env)`);
      }
    }
  }

  // If --exclude-env names were specified, add them to the excluded set
  if (config.excludeEnv && config.excludeEnv.length > 0) {
    for (const name of config.excludeEnv) {
      EXCLUDED_ENV_VARS.add(name);
    }
  }

  // If --env-all is specified, pass through all host environment variables (except excluded ones)
  if (config.envAll) {
    const skippedLargeVars: string[] = [];
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !EXCLUDED_ENV_VARS.has(key) && !Object.prototype.hasOwnProperty.call(environment, key)) {
        // Skip oversized values to prevent E2BIG (Argument list too long) errors.
        // The Linux kernel enforces ARG_MAX (~2MB) on argv+envp combined; large env
        // vars can exhaust this budget, especially when combined with large prompts.
        const valueSizeBytes = Buffer.byteLength(value, 'utf8');
        if (valueSizeBytes > MAX_ENV_VALUE_SIZE) {
          skippedLargeVars.push(`${key} (${(valueSizeBytes / 1024).toFixed(0)} KB)`);
          continue;
        }
        environment[key] = value;
      }
    }
    if (skippedLargeVars.length > 0) {
      logger.warn(`Skipped ${skippedLargeVars.length} oversized env var(s) from --env-all passthrough (>${(MAX_ENV_VALUE_SIZE / 1024).toFixed(0)} KB each):`);
      for (const entry of skippedLargeVars) {
        logger.warn(`  - ${entry}`);
      }
      logger.warn('Use --env VAR="$VAR" to explicitly pass large values if needed.');
    }
  } else {
    // Default behavior: selectively pass through specific variables.
    // Always-forward: GitHub auth, user environment, enterprise URLs, Actions OIDC, Docker client.
    const alwaysForwardVars = [
      // GitHub authentication
      'GITHUB_TOKEN',
      'GH_TOKEN',
      'GITHUB_PERSONAL_ACCESS_TOKEN',
      // User environment
      'USER',
      'XDG_CONFIG_HOME',
      // Enterprise environment variables — needed for GHEC/GHES Copilot authentication
      'GITHUB_SERVER_URL',
      // GITHUB_API_URL — always pass when set. The Copilot CLI needs it to locate the GitHub API
      // (especially on GHES/GHEC where the URL differs from api.github.com).
      // Copilot-specific API calls (inference and token exchange) always route through
      // COPILOT_API_URL → api-proxy when api-proxy is enabled, so GITHUB_API_URL does not
      // interfere with credential isolation.
      'GITHUB_API_URL',
      // GitHub Actions OIDC — required for MCP servers with auth.type: 'github-oidc'
      'ACTIONS_ID_TOKEN_REQUEST_URL',
      'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
      // Forward Docker client environment so the agent workload can reach the same DinD daemon,
      // custom Docker socket, or TCP endpoint as the parent process. DOCKER_HOST alone is not
      // sufficient for TLS/authenticated daemons; the companion Docker client variables must also
      // be preserved so docker commands inside the agent work as expected.
      'DOCKER_HOST',
      'DOCKER_TLS',
      'DOCKER_TLS_VERIFY',
      'DOCKER_CERT_PATH',
      'DOCKER_CONTEXT',
      'DOCKER_CONFIG',
      'DOCKER_API_VERSION',
      'DOCKER_DEFAULT_PLATFORM',
    ] as const;
    for (const v of alwaysForwardVars) {
      if (process.env[v]) environment[v] = process.env[v]!;
    }

    // API keys for LLM providers — skip when api-proxy is enabled
    // (the sidecar holds the keys; the agent uses *_BASE_URL instead).
    // COPILOT_GITHUB_TOKEN / COPILOT_API_KEY (BYOK) — forward when api-proxy is NOT enabled;
    // when api-proxy IS enabled, placeholder values are set earlier for credential isolation.
    if (!config.enableApiProxy) {
      for (const v of [
        'OPENAI_API_KEY',
        'CODEX_API_KEY',
        'ANTHROPIC_API_KEY',
        'COPILOT_GITHUB_TOKEN',
        'COPILOT_API_KEY',
      ] as const) {
        if (process.env[v]) environment[v] = process.env[v]!;
      }
    }

    // When --tty is set, we use TERM=xterm-256color (set above); otherwise inherit host TERM
    if (process.env.TERM && !config.tty) environment.TERM = process.env.TERM;

  }

  // Always derive GH_HOST from GITHUB_SERVER_URL to prevent proxy-rewritten values
  // (e.g. GH_HOST=localhost:18443 from DIFC proxy) from breaking gh CLI remote matching.
  // When running inside GitHub Actions, GITHUB_SERVER_URL is injected by the Actions
  // runner and points to the real GitHub instance for the workflow run, so within that
  // context it is the canonical source of truth. Outside Actions it may be unset.
  // Must run AFTER the env-all block so it overrides any leaked proxy values.
  const ghHost = extractGhHostFromServerUrl(process.env.GITHUB_SERVER_URL);
  if (ghHost) {
    environment.GH_HOST = ghHost;
    logger.debug(`Set GH_HOST=${ghHost} from GITHUB_SERVER_URL`);
  } else if (environment.GH_HOST) {
    // When GITHUB_SERVER_URL does not yield a custom host (e.g. github.com, unset, or invalid),
    // GH_HOST should not be set. If --env-all passed through a proxy-rewritten value, remove it
    // so gh CLI uses its default behavior (github.com). See: gh-aw-firewall#1492
    delete environment.GH_HOST;
    logger.debug('Removed GH_HOST from environment; falling back to gh CLI default since GITHUB_SERVER_URL did not yield a custom host override');
  }

  // Forward one-shot-token debug flag if set (used for testing/debugging)
  if (process.env.AWF_ONE_SHOT_TOKEN_DEBUG) {
    environment.AWF_ONE_SHOT_TOKEN_DEBUG = process.env.AWF_ONE_SHOT_TOKEN_DEBUG;
  }

  // Environment variables from --env-file (injected before --env flags so explicit flags win)
  if (config.envFile) {
    const fileEnv = readEnvFile(config.envFile);
    for (const [key, value] of Object.entries(fileEnv)) {
      if (!EXCLUDED_ENV_VARS.has(key) && !Object.prototype.hasOwnProperty.call(environment, key)) {
        environment[key] = value;
      }
    }
  }

  // Additional environment variables from --env flags (these override everything)
  if (config.additionalEnv) {
    Object.assign(environment, config.additionalEnv);
  }

  // Normalize NO_PROXY / no_proxy after additionalEnv is applied.
  // If --env overrides one casing but not the other, HTTP clients that prefer the
  // other casing (e.g., Go uses NO_PROXY, Python requests uses no_proxy) would
  // still route through Squid. Sync them with NO_PROXY taking precedence.
  if (environment.NO_PROXY !== environment.no_proxy) {
    if (config.additionalEnv?.NO_PROXY) {
      environment.no_proxy = environment.NO_PROXY;
    } else if (config.additionalEnv?.no_proxy) {
      environment.NO_PROXY = environment.no_proxy;
    }
  }

  // Warn when total environment size approaches ARG_MAX (~2MB).
  // Linux enforces a combined argv+envp limit; large environments can cause E2BIG errors
  // when execve() is called inside the container.
  if (config.envAll) {
    const totalEnvBytes = Object.entries(environment)
      .reduce((sum, [k, v]) => sum + k.length + (v?.length ?? 0) + 2, 0); // +2 for '=' and null
    if (totalEnvBytes > ENV_SIZE_WARNING_THRESHOLD) {
      logger.warn(
        `⚠️  Total container environment size is ${(totalEnvBytes / 1024).toFixed(0)} KB — ` +
        'may cause E2BIG (Argument list too long) errors when combined with large command arguments'
      );
      logger.warn('   Consider using --exclude-env to remove unnecessary variables');
    }
  }

  // DNS servers for Docker embedded DNS forwarding (used in docker-compose dns: field)
  // Pass DNS servers to container so setup-iptables.sh can allow Docker DNS forwarding
  // to these upstream servers while blocking direct DNS to all other servers.
  environment.AWF_DNS_SERVERS = dnsServers.join(',');

  // When DoH is enabled, tell the agent container to route DNS through the DoH proxy
  if (config.dnsOverHttps && networkConfig.dohProxyIp) {
    environment.AWF_DOH_ENABLED = 'true';
    environment.AWF_DOH_PROXY_IP = networkConfig.dohProxyIp;
  }

  // Pass allowed ports to container for setup-iptables.sh (if specified)
  if (config.allowHostPorts) {
    environment.AWF_ALLOW_HOST_PORTS = config.allowHostPorts;
  }

  // Pass host service ports to container for setup-iptables.sh (if specified)
  // These ports bypass DANGEROUS_PORTS validation and are only allowed to host gateway
  if (config.allowHostServicePorts) {
    environment.AWF_HOST_SERVICE_PORTS = config.allowHostServicePorts;
    // Ensure host access is enabled (setup-iptables.sh requires AWF_ENABLE_HOST_ACCESS)
    // The CLI auto-enables this, but this is a safety net for programmatic usage
    if (!environment.AWF_ENABLE_HOST_ACCESS) {
      environment.AWF_ENABLE_HOST_ACCESS = '1';
    }
  }

  // Pass chroot mode flag to container for entrypoint.sh capability drop
  environment.AWF_CHROOT_ENABLED = 'true';
  // Pass the container working directory for chroot mode
  // If containerWorkDir is set, use it; otherwise use home directory
  // The entrypoint will strip /host prefix to get the correct path inside chroot
  if (config.containerWorkDir) {
    environment.AWF_WORKDIR = config.containerWorkDir;
  } else {
    // Default to real user's home directory (not /root when running with sudo)
    environment.AWF_WORKDIR = getRealUserHome();
  }

  // Pass host UID/GID for runtime user adjustment in entrypoint
  // This ensures awfuser UID/GID matches host user for correct file ownership
  environment.AWF_USER_UID = getSafeHostUid();
  environment.AWF_USER_GID = getSafeHostGid();
  // Note: UID/GID values are logged by the container entrypoint if needed for debugging

  // Signal to entrypoint.sh that Gemini CLI is expected — only when geminiApiKey is configured.
  // This guards the ~/.gemini ownership fix and avoids spurious Gemini-related log output in
  // Copilot (or other non-Gemini) runs.
  if (config.geminiApiKey) {
    environment.AWF_GEMINI_ENABLED = '1';
  }

  // Add SSL CA certificate mount environment variable if SSL Bump is enabled
  if (sslConfig) {
    // Set environment variable to indicate SSL Bump is enabled
    environment.AWF_SSL_BUMP_ENABLED = 'true';
    // Tell Node.js to trust the AWF session CA certificate.
    // Without this, Node.js tools (Yarn 4, Corepack, npm) fail with EPROTO
    // because Node.js uses its own CA bundle, not the system CA store.
    environment.NODE_EXTRA_CA_CERTS = '/usr/local/share/ca-certificates/awf-ca.crt';
  }

  return environment;
}
