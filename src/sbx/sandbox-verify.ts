import { isDomainMatchedByPattern, parseDomainList } from '../domain-matchers';
import { logger } from '../logger';
import { execInSandbox } from './sandbox-exec';

const SBX_EGRESS_PROBE_DOMAINS = [
  '1.1.1.1',
  'example.com',
  'example.org',
  'example.net',
  'iana.org',
  'microsoft.com',
  'google.com',
] as const;

/**
 * Adds a resolver alias for the published API proxy and proves that the
 * hard-coded gh-aw reflection endpoint is reachable before the agent starts.
 */
export async function assertSbxApiProxyReflect(
  name: string,
  environment: Record<string, string>,
  workDir?: string,
): Promise<void> {
  environment.HOSTALIASES = '/tmp/awf-hostaliases';
  const bridgeSource = [
    'const http = require("node:http");',
    'const upstreamHost = "host.docker.internal";',
    'http.createServer((request, response) => {',
    'const upstream = http.request({',
    'hostname: upstreamHost,',
    'port: 10000,',
    'method: request.method,',
    'path: request.url,',
    'headers: { ...request.headers, host: `${upstreamHost}:10000` },',
    '}, upstreamResponse => {',
    'response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);',
    'upstreamResponse.pipe(response);',
    '});',
    'upstream.on("error", error => {',
    'if (!response.headersSent) response.writeHead(502);',
    'response.end(error.message);',
    '});',
    'request.pipe(upstream);',
    '}).listen(10000, "127.0.0.1");',
  ].join('\n');
  const encodedBridge = Buffer.from(bridgeSource).toString('base64');
  const command = [
    'umask 077',
    'printf "api-proxy localhost\\n" > "$HOSTALIASES"',
    `printf %s ${encodedBridge} | base64 --decode > /tmp/awf-reflect-bridge.cjs`,
    '{ nohup node /tmp/awf-reflect-bridge.cjs >/tmp/awf-reflect-bridge.log 2>&1 & }',
    [
      '{',
      'for attempt in $(seq 1 30); do',
      'if AWF_REFLECT_ATTEMPT="$attempt" node -e',
      '\'fetch("http://api-proxy:10000/reflect", { signal: AbortSignal.timeout(500) }).then(',
      'async response => {',
      'if (!response.ok && process.env.AWF_REFLECT_ATTEMPT === "30")',
      'console.error(`HTTP ${response.status}: ${await response.text()}`);',
      'process.exit(response.ok ? 0 : 1);',
      '}',
      ').catch(error => {',
      'if (process.env.AWF_REFLECT_ATTEMPT === "30") console.error(error, error.cause);',
      'process.exit(1);',
      '})\'',
      '; then exit 0; fi;',
      'sleep 1;',
      'done;',
      'cat /tmp/awf-reflect-bridge.log >&2 || true;',
      'exit 1;',
      '}',
    ].join(' '),
  ].join(' && ');

  const result = await execInSandbox(name, command, {
    timeoutMinutes: 1,
    workDir,
    environment,
  });
  if (result.exitCode !== 0) {
    throw new Error('sbx sandbox cannot reach the API proxy /reflect endpoint');
  }
}

/**
 * Absorb a transient Squid startup race without weakening the fail-closed
 * guarantee for a persistent bypass.
 */
const EGRESS_PROBE_MAX_ATTEMPTS = 3;
const EGRESS_PROBE_RETRY_DELAY_MS = 2_000;

/**
 * Fails closed when an sbx guest can reach a domain that Squid policy denies
 * after every conventional proxy environment variable has been removed.
 *
 * The check is opt-in because AWF does not own the long-lived sbx daemon.
 * An orchestrator must start that daemon with DOCKER_SANDBOXES_PROXY chained
 * to AWF's published Squid endpoint before enabling this verification.
 */
export async function assertSbxEgressEnforced(
  name: string,
  environment: Record<string, string>,
  allowedDomains: string[],
  workDir?: string,
): Promise<void> {
  const probeDomains = selectDeniedProbeDomains(allowedDomains);
  if (probeDomains.length === 0) {
    throw new Error(
      'Cannot verify Docker sbx egress: the allowlist covers every built-in probe domain',
    );
  }

  // Ignore certificate trust so TLS interception cannot masquerade as blocked
  // transport; HTTP error responses still count as blocked via --fail.
  const probeCommands = probeDomains.map(domain =>
    `if env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy ` +
    `-u ALL_PROXY -u all_proxy -u NO_PROXY -u no_proxy ` +
    `curl --disable --fail --insecure --silent --show-error --connect-timeout 5 --max-time 10 ` +
    `--output /dev/null "https://${domain}/"; then ` +
    `echo "Direct sbx egress reached ${domain} without proxy environment variables" >&2; ` +
    'exit 86; fi'
  );
  const command = [
    'command -v curl >/dev/null || exit 127',
    ...probeCommands,
  ].join(' && ');

  let lastExitCode = 0;
  for (let attempt = 1; attempt <= EGRESS_PROBE_MAX_ATTEMPTS; attempt++) {
    const result = await execInSandbox(name, command, {
      timeoutMinutes: 1,
      workDir,
      environment,
    });
    lastExitCode = result.exitCode;

    if (result.exitCode === 0) {
      return;
    }
    if (result.exitCode !== 86) {
      // Not a bypass (e.g. curl missing) — retrying can't help, fail closed now.
      throw new Error(
        `Could not verify Docker sbx egress enforcement (probe exit ${result.exitCode})`,
      );
    }
    // exitCode === 86: a probe reached the internet directly. This can be a
    // transient Squid warm-up race, so retry before declaring a real bypass.
    if (attempt < EGRESS_PROBE_MAX_ATTEMPTS) {
      logger.warn(
        `[sbx] Egress probe reached the internet directly on attempt ${attempt}/` +
        `${EGRESS_PROBE_MAX_ATTEMPTS}; retrying in case Squid is still starting up`,
      );
      await new Promise(resolve => setTimeout(resolve, EGRESS_PROBE_RETRY_DELAY_MS));
    }
  }

  if (lastExitCode === 86) {
    throw new Error(
      'Docker sbx direct egress bypassed Squid; ensure the sbx daemon was started with ' +
      'DOCKER_SANDBOXES_PROXY pointing to AWF Squid',
    );
  }
}

function selectDeniedProbeDomains(allowedDomains: string[]): string[] {
  const parsed = parseDomainList(allowedDomains);
  return SBX_EGRESS_PROBE_DOMAINS
    .filter(domain => {
      const entry = { domain, protocol: 'https' as const };
      const plainMatch = parsed.plainDomains.some(allowed => {
        if (allowed.protocol !== 'both' && allowed.protocol !== 'https') return false;
        const allowedDomain = allowed.domain.replace(/^\./, '').toLowerCase();
        return domain === allowedDomain || domain.endsWith(`.${allowedDomain}`);
      });
      return !plainMatch && !isDomainMatchedByPattern(entry, parsed.patterns);
    })
    .slice(0, 3);
}
