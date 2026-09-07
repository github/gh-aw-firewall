/**
 * Compiler-to-AWF private handoff for dynamic GitHub-MCP-backed enclave
 * repository admission (ADR 0001 `docs/adr/0001-agent-enclaves.md`).
 *
 * gh-aw starts mcpg's `github-repository-delegation-v1` controller and hands
 * AWF two values that no other principal may ever observe:
 *
 * - `AWF_ENCLAVE_GITHUB_DELEGATION_CONTROL_ENDPOINT`: the *control plane*,
 *   published by Docker on the runner's own `127.0.0.1` only
 *   (`-p 127.0.0.1:<port>:<port>`). It is deliberately distinct from the
 *   executor-facing `AWF_ENCLAVE_MCP_GATEWAY_ENDPOINT` data plane.
 * - `AWF_ENCLAVE_GITHUB_DELEGATION_CONTROL_CAPABILITY`: the AWF-only bearer
 *   for that control plane (`openssl rand -hex 32`).
 *
 * Because the control listener is published on host loopback, the *AWF host
 * process* is the only component that can reach it **through the published
 * port**, which is why the control client lives here rather than in the broker
 * container.
 *
 * That is a statement about the host publication, not a general routing
 * guarantee, and it is worth being precise about the difference. Under network
 * isolation gh-aw binds the in-container listener to `0.0.0.0`, because Docker
 * NATs a published port to the container's bridge IP and so a container-local
 * `127.0.0.1` bind would be unreachable. A peer that shares a Docker network
 * with mcpg addresses the container IP directly and never traverses the
 * published port at all, so co-attached peers — notably the single-use
 * executor, which meets mcpg at `172.31.0.40` on the enclave agent network —
 * are not kept off the control plane by publication scope.
 *
 * What actually protects the control plane is authentication, not
 * unreachability: every control request must carry the AWF-only capability,
 * mcpg rejects anything else with `403 delegation_access_denied`, and AWF takes
 * custody of both values before any inherited environment is assembled, keeps
 * them in AWF-private state with exclusive `0600` files, and never mounts
 * either one into a container.
 */

import * as fs from 'fs';
import type { EnclavePaths } from './paths';

export const ENCLAVE_GITHUB_DELEGATION_CONTROL_ENDPOINT_ENV =
  'AWF_ENCLAVE_GITHUB_DELEGATION_CONTROL_ENDPOINT';
export const ENCLAVE_GITHUB_DELEGATION_CONTROL_CAPABILITY_ENV =
  'AWF_ENCLAVE_GITHUB_DELEGATION_CONTROL_CAPABILITY';

/**
 * Fixed control API base path served by mcpg v0.4.18
 * (`internal/proxy/delegation.go`: `delegationControlPath`). Operations are
 * siblings of the controller name, not children of it.
 */
export const DELEGATION_CONTROL_API_BASE_PATH = '/internal/awf-enclave-mcp-control';

/** The single delegation controller AWF understands. */
export const DELEGATION_CONTROLLER_NAME = 'github-repository-delegation-v1';

/** Exact endpoint path gh-aw exports for the controller. */
export const DELEGATION_CONTROL_ENDPOINT_PATH =
  `${DELEGATION_CONTROL_API_BASE_PATH}/${DELEGATION_CONTROLLER_NAME}`;

/**
 * Literal loopback hosts AWF accepts, as WHATWG `URL.hostname` renders them.
 *
 * `localhost` is deliberately absent: it is resolver-dependent, so a poisoned
 * `/etc/hosts`, NSS module, or search domain could point the AWF-only control
 * capability at an attacker-controlled listener. Only the two literal loopback
 * addresses are trusted.
 */
const LITERAL_LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]']);

/** Default port the WHATWG URL parser normalizes away for `http:` origins. */
const HTTP_DEFAULT_PORT = 80;

export interface EnclaveDynamicDelegationEndpoint {
  /** Endpoint exactly as the compiler exported it, after strict validation. */
  readonly href: string;
  /** Literal loopback host, e.g. `127.0.0.1` or `[::1]`. */
  readonly host: string;
  /**
   * Effective TCP port. `http://127.0.0.1/...` and `http://127.0.0.1:80/...`
   * are indistinguishable after WHATWG normalization, so both resolve to 80
   * rather than being rejected for an "absent" port.
   */
  readonly port: number;
  /** Absolute origin AWF issues control requests against. */
  readonly origin: string;
  /** `${DELEGATION_CONTROL_API_BASE_PATH}/` — the operation path prefix. */
  readonly operationBasePath: string;
}

export interface EnclaveDynamicDelegationHandoff {
  readonly endpoint: EnclaveDynamicDelegationEndpoint;
  readonly capability: string;
}

/** Whether a value is a well-formed 256-bit lowercase hex control capability. */
export function isValidEnclaveDynamicDelegationCapability(
  value: string | undefined,
): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/**
 * Parses the compiler-issued control endpoint, or returns `undefined` when it
 * is anything other than the exact loopback-only HTTP control endpoint mcpg
 * publishes.
 *
 * Rejected: every non-`http:` scheme (including `https:`, which the controller
 * does not serve), `localhost` and every other resolver-dependent name, any
 * routable or wildcard address, embedded credentials, a query string, a
 * fragment, and any path other than the fixed controller path. A wrong path is
 * fatal rather than rewritten, because silently repointing an AWF-only
 * capability at an unknown listener is exactly the failure this check exists
 * to prevent.
 */
export function parseEnclaveDynamicDelegationControlEndpoint(
  value: string | undefined,
): EnclaveDynamicDelegationEndpoint | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:') return undefined;
  if (!LITERAL_LOOPBACK_HOSTS.has(url.hostname)) return undefined;
  if (url.username !== '' || url.password !== '') return undefined;
  if (url.search !== '' || url.hash !== '') return undefined;
  if (url.pathname !== DELEGATION_CONTROL_ENDPOINT_PATH) return undefined;
  const port = url.port === '' ? HTTP_DEFAULT_PORT : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return Object.freeze({
    href: url.href,
    host: url.hostname,
    port,
    origin: url.origin,
    operationBasePath: `${DELEGATION_CONTROL_API_BASE_PATH}/`,
  });
}

/** Back-compatible predicate form of {@link parseEnclaveDynamicDelegationControlEndpoint}. */
export function isValidEnclaveDynamicDelegationControlEndpoint(
  value: string | undefined,
): value is string {
  return parseEnclaveDynamicDelegationControlEndpoint(value) !== undefined;
}

/**
 * Reads and deletes both handoff values from `env`, so neither can leak into
 * an inherited environment after this call. Returns the raw values without
 * judging them; validity is decided by {@link resolveEnclaveDynamicDelegationHandoff}
 * so preflight can distinguish "absent" from "present but malformed".
 */
export function takeEnclaveDynamicDelegationHandoff(
  env: NodeJS.ProcessEnv,
): { endpoint?: string; capability?: string } {
  const endpoint = env[ENCLAVE_GITHUB_DELEGATION_CONTROL_ENDPOINT_ENV];
  const capability = env[ENCLAVE_GITHUB_DELEGATION_CONTROL_CAPABILITY_ENV];
  delete env[ENCLAVE_GITHUB_DELEGATION_CONTROL_ENDPOINT_ENV];
  delete env[ENCLAVE_GITHUB_DELEGATION_CONTROL_CAPABILITY_ENV];
  if (env !== process.env) {
    delete process.env[ENCLAVE_GITHUB_DELEGATION_CONTROL_ENDPOINT_ENV];
    delete process.env[ENCLAVE_GITHUB_DELEGATION_CONTROL_CAPABILITY_ENV];
  }
  return { endpoint, capability };
}

export interface EnclaveDynamicDelegationHandoffResolution {
  handoff?: EnclaveDynamicDelegationHandoff;
  /**
   * Operator-facing reasons the handoff is unusable. Never contains the
   * capability, and never contains the endpoint of a *valid* handoff.
   */
  errors: string[];
}

/**
 * Validates a raw handoff pair. Both values must be present and valid: a
 * partial handoff is a hard failure, never a degraded mode.
 */
export function resolveEnclaveDynamicDelegationHandoff(
  raw: { endpoint?: string; capability?: string },
): EnclaveDynamicDelegationHandoffResolution {
  const errors: string[] = [];
  const endpoint = parseEnclaveDynamicDelegationControlEndpoint(raw.endpoint);
  if (raw.endpoint === undefined || raw.endpoint === '') {
    errors.push(
      `enclaves[].dynamic requires ${ENCLAVE_GITHUB_DELEGATION_CONTROL_ENDPOINT_ENV}: the compiler `
      + 'must start mcpg\'s "github-repository-delegation-v1" controller and hand AWF its private '
      + 'control endpoint. AWF never falls back to a static seed catalog, a job-lifetime identity, '
      + 'or a broader policy.',
    );
  } else if (!endpoint) {
    errors.push(
      `${ENCLAVE_GITHUB_DELEGATION_CONTROL_ENDPOINT_ENV} must be the loopback-only mcpg control `
      + `endpoint "http://127.0.0.1:<port>${DELEGATION_CONTROL_ENDPOINT_PATH}". AWF rejects `
      + 'resolver-dependent hosts (including "localhost"), non-loopback and wildcard addresses, '
      + 'embedded credentials, query strings, fragments, and any other path.',
    );
  }
  if (raw.capability === undefined || raw.capability === '') {
    errors.push(
      `enclaves[].dynamic requires ${ENCLAVE_GITHUB_DELEGATION_CONTROL_CAPABILITY_ENV}: the `
      + 'AWF-only capability that authorizes create/confirm/status/reconcile/revoke on the mcpg '
      + 'delegation control channel.',
    );
  } else if (!isValidEnclaveDynamicDelegationCapability(raw.capability)) {
    errors.push(
      `${ENCLAVE_GITHUB_DELEGATION_CONTROL_CAPABILITY_ENV} must be a 256-bit lowercase hex `
      + 'capability minted by the compiler.',
    );
  }
  if (errors.length > 0 || !endpoint || !isValidEnclaveDynamicDelegationCapability(raw.capability)) {
    return { errors };
  }
  return { handoff: { endpoint, capability: raw.capability }, errors };
}

function writeExclusivePrivateFile(target: string, content: string): void {
  fs.rmSync(target, { force: true });
  const fd = fs.openSync(
    target,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeSync(fd, content);
    fs.fchmodSync(fd, 0o600);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Persists the handoff into AWF-private state with exclusive `0600` files
 * inside the already-`0700` private root.
 *
 * These files exist so a later phase of the same AWF process (teardown,
 * reconciliation) can re-read the handoff without keeping it in a long-lived
 * environment variable. They are never bind-mounted into the broker, the
 * executor, the model sidecar, the general MCP route, or the delegated data
 * plane — `src/services/enclave-mcp-service.ts` mounts neither path, and
 * `assertPrivateRootIsolated` keeps the whole private root out of every
 * agent-visible mount.
 */
export function stageEnclaveDynamicDelegationHandoff(
  paths: EnclavePaths,
  handoff: EnclaveDynamicDelegationHandoff,
): void {
  writeExclusivePrivateFile(paths.delegationEndpointPath, `${handoff.endpoint.href}\n`);
  writeExclusivePrivateFile(paths.delegationCapabilityPath, `${handoff.capability}\n`);
}

/**
 * Re-reads a previously staged handoff. Returns `undefined` when either file
 * is missing, is not a regular file, is group/other readable, or no longer
 * contains a valid value: a tampered handoff is never used.
 */
export function readStagedEnclaveDynamicDelegationHandoff(
  paths: EnclavePaths,
): EnclaveDynamicDelegationHandoff | undefined {
  const endpoint = parseEnclaveDynamicDelegationControlEndpoint(
    readPrivateFile(paths.delegationEndpointPath),
  );
  const capability = readPrivateFile(paths.delegationCapabilityPath);
  if (!endpoint || !isValidEnclaveDynamicDelegationCapability(capability)) return undefined;
  return { endpoint, capability };
}

function readPrivateFile(target: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 4096) return undefined;
    return fs.readFileSync(fd, 'ascii').trim();
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
