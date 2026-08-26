/**
 * Argv token validation shared by the Apple Container adapter.
 *
 * Every value reaches the `container` CLI as its own argv element and no shell
 * is ever involved, so classic quoting/injection is already impossible. The
 * residual risk is *flag-value* injection: several Apple Container options pack
 * multiple fields into a single argv token using structural delimiters
 * (`--mount type=bind,source=…,target=…,readonly`, `--publish-socket
 * host_path:container_path`, `--env KEY=VALUE`, `--network name,mac=…`). A
 * value that smuggles in a delimiter would silently add or override sibling
 * fields inside the same token, so each component is validated against the
 * delimiter set of the token it will be embedded in *before* it is joined.
 *
 * Everything here fails closed: an invalid value throws rather than being
 * dropped, escaped, or coerced, so a caller can never end up with a launch that
 * quietly differs from the one it asked for.
 */

import * as path from 'path';

/**
 * Apple Container's own container-ID predicate, mirrored from
 * `ManagedContainer.nameValid` in apple/container: at most 63 characters (DNS
 * label maximum), starting with an alphanumeric, and at least two characters
 * long. Generated IDs are lowercased UUIDs, which also satisfy this pattern, so
 * the same check covers both user-supplied names and returned IDs.
 */
const CONTAINER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,62}$/;

/** POSIX-portable environment variable name. */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `CAP_NET_RAW`, `NET_RAW`, or `ALL`; matched case-insensitively by the CLI. */
const CAPABILITY_PATTERN = /^(?:CAP_)?[A-Z][A-Z0-9_]*$/i;

/** Apple Container memory sizes: an integer with an optional K/M/G/T/P suffix. */
const MEMORY_SIZE_PATTERN = /^[1-9][0-9]*[KMGTP]?$/;

/** Conservative subset of OCI reference syntax; excludes every argv delimiter. */
const IMAGE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/;

/** Network attachment names accepted by `--network`. */
const NETWORK_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;

/** `container system logs --last`: `<number>[m|h|d]`, bare numbers are seconds. */
const LOG_WINDOW_PATTERN = /^[1-9][0-9]*[mhd]?$/;

const MAX_PATH_BYTES = 4096;

function assertPrintableToken(value: string, label: string): void {
  if (value.length === 0) {
    throw new Error(`Apple Container ${label} must not be empty`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Apple Container ${label} must not contain control characters`);
  }
}

/**
 * Rejects a token that would be misread as an option by Swift ArgumentParser.
 *
 * Only relevant for values placed where the parser is still scanning for
 * options. `container run`/`create` declare their trailing arguments with
 * `.captureForPassthrough`, so the container's own command line is exempt and
 * is deliberately *not* routed through this check.
 */
function assertNotOptionLike(value: string, label: string): void {
  if (value.startsWith('-')) {
    throw new Error(`Apple Container ${label} must not begin with "-": ${value}`);
  }
}

/** Validates a container name or ID against Apple Container's own predicate. */
export function assertAppleContainerId(value: string, label = 'container ID'): string {
  assertPrintableToken(value, label);
  if (!CONTAINER_ID_PATTERN.test(value)) {
    throw new Error(
      `Apple Container ${label} must be 2-63 characters of [A-Za-z0-9_.-] starting with ` +
      `an alphanumeric: ${value}`,
    );
  }
  return value;
}

export function assertAppleContainerImageReference(value: string): string {
  assertPrintableToken(value, 'image reference');
  assertNotOptionLike(value, 'image reference');
  if (!IMAGE_REFERENCE_PATTERN.test(value) || value.length > 512) {
    throw new Error(`Apple Container image reference is not a valid OCI reference: ${value}`);
  }
  return value;
}

export function assertAppleContainerNetworkName(value: string): string {
  assertPrintableToken(value, 'network name');
  if (!NETWORK_NAME_PATTERN.test(value)) {
    throw new Error(`Apple Container network name is not valid: ${value}`);
  }
  return value;
}

/**
 * Validates an absolute, already-normalised path and rejects every delimiter
 * used by the flag token it will be embedded in.
 *
 * `forbidden` is required rather than defaulted so each call site has to state
 * which token it is building; `--mount` is comma/equals-delimited while
 * `--publish-socket` is colon-delimited, and using the wrong set would leave a
 * real injection path open.
 */
export function assertAppleContainerPath(
  value: string,
  label: string,
  forbidden: readonly string[],
): string {
  assertPrintableToken(value, label);
  if (!path.posix.isAbsolute(value)) {
    throw new Error(`Apple Container ${label} must be an absolute POSIX path: ${value}`);
  }
  if (path.posix.normalize(value) !== value || (value.length > 1 && value.endsWith('/'))) {
    // `path.posix.normalize` preserves a trailing slash, so it is checked
    // separately; otherwise `/workspace` and `/workspace/` would build two
    // different mount tokens for the same directory.
    throw new Error(`Apple Container ${label} must be a normalized path: ${value}`);
  }
  if (Buffer.byteLength(value) > MAX_PATH_BYTES) {
    throw new Error(`Apple Container ${label} exceeds ${MAX_PATH_BYTES} bytes: ${value}`);
  }
  for (const delimiter of forbidden) {
    if (value.includes(delimiter)) {
      throw new Error(
        `Apple Container ${label} must not contain "${delimiter}", which delimits fields ` +
        `within the flag value: ${value}`,
      );
    }
  }
  return value;
}

export function assertAppleContainerEnvName(name: string): string {
  assertPrintableToken(name, 'environment variable name');
  if (!ENV_NAME_PATTERN.test(name)) {
    throw new Error(`Apple Container environment variable name is not valid: ${name}`);
  }
  return name;
}

/** Validates a label key without applying the stricter environment-name syntax. */
export function assertAppleContainerLabelName(name: string): string {
  assertPrintableToken(name, 'label name');
  if (name.includes('=')) {
    throw new Error(`Apple Container label name must not contain "=": ${name}`);
  }
  return name;
}

/**
 * Validates an environment value. Newlines and NULs are rejected because the
 * CLI's `--env` value is a single `KEY=VALUE` argv token; `=` is explicitly
 * allowed since only the first one is significant (`Parser.env` passes the raw
 * string through and later splits it with `maxSplits: 1`).
 */
export function assertAppleContainerEnvValue(name: string, value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000\n\r]/.test(value)) {
    throw new Error(
      `Apple Container environment variable "${name}" must not contain NUL or newlines`,
    );
  }
  return value;
}

/**
 * Validates a `--label` value.
 *
 * Unlike `--env`, labels are *not* `=`-tolerant: `Parser.labels` splits with
 * `maxSplits: 2` and rejects anything that yields three components, so a value
 * containing `=` would build a clean-looking argv and then fail inside
 * `container create`. Reject it here instead.
 */
export function assertAppleContainerLabelValue(name: string, value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000\n\r]/.test(value)) {
    throw new Error(`Apple Container label "${name}" must not contain NUL or newlines`);
  }
  if (value.includes('=')) {
    throw new Error(
      `Apple Container label "${name}" value must not contain "=", which delimits fields ` +
      `within the flag value: ${value}`,
    );
  }
  return value;
}

export function assertAppleContainerCapability(value: string): string {
  assertPrintableToken(value, 'capability');
  if (!CAPABILITY_PATTERN.test(value)) {
    throw new Error(`Apple Container capability name is not valid: ${value}`);
  }
  return value;
}

export function assertAppleContainerCpuCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Apple Container CPU count must be a positive integer; got ${value}`);
  }
  return value;
}

export function assertAppleContainerMemorySize(value: string): string {
  assertPrintableToken(value, 'memory size');
  if (!MEMORY_SIZE_PATTERN.test(value)) {
    throw new Error(
      'Apple Container memory size must be an integer with an optional K/M/G/T/P suffix; ' +
      `got ${value}`,
    );
  }
  return value;
}

export function assertAppleContainerLogWindow(value: string): string {
  assertPrintableToken(value, 'log window');
  if (!LOG_WINDOW_PATTERN.test(value)) {
    throw new Error(
      `Apple Container log window must be <number>[m|h|d] (bare numbers are seconds); got ${value}`,
    );
  }
  return value;
}

/** Validates a POSIX signal name for `container stop --signal` / `container kill --signal`. */
export function assertAppleContainerSignal(value: string): string {
  assertPrintableToken(value, 'signal name');
  if (!/^(?:SIG)?[A-Z][A-Z0-9]*$/.test(value)) {
    throw new Error(`Apple Container signal name must be an uppercase POSIX signal; got ${value}`);
  }
  return value;
}

/** Validates the `--time` grace period for `container stop`, in whole seconds. */
export function assertAppleContainerStopTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 86_400) {
    throw new Error(
      `Apple Container stop timeout must be an integer number of seconds in 0..86400; got ${value}`,
    );
  }
  return value;
}

/**
 * Validates a line bound used by diagnostics collection. Log capture is always
 * bounded so a runaway guest cannot fill the host disk.
 */
export function assertAppleContainerLineCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100_000) {
    throw new Error(`Apple Container log line count must be an integer in 1..100000; got ${value}`);
  }
  return value;
}

/** Validates a timeout used to bound a diagnostics command. */
export function assertAppleContainerTimeoutMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Apple Container diagnostics timeout must be a positive integer; got ${value}`);
  }
  return value;
}
