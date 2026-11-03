'use strict';

const MAX_PROBE_BYTES = 4096;
const VERSION = '(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?';
const EXECUTABLE = /^(?:\/|\.\/)?[A-Za-z0-9_.+/-]{1,256}$/;
const HARNESS_NAMES = { copilot: 'copilot-cli', claude: 'claude-code', codex: 'codex-cli' };
const REASONS = new Set([
  'selection_unavailable', 'runtime_probe_unsupported', 'probe_pending',
  'probe_failed', 'probe_timed_out', 'probe_output_limit', 'binary_missing',
  'probe_output_invalid', 'observation_missing', 'observation_invalid',
  'observation_environment_mismatch', 'observation_harness_mismatch',
]);

// Deliberately not a shell parser: wrappers, assignments, quoting and compound
// commands cannot establish which binary will actually make a later request.
function selectHarness(command) {
  if (typeof command !== 'string' || /[;&|<>`$\\\r\n]/.test(command)) return undefined;
  const binary = command.trim().split(/\s+/, 1)[0];
  if (!EXECUTABLE.test(binary)) return undefined;
  const name = binary.split('/').pop();
  return Object.hasOwn(HARNESS_NAMES, name) ? Object.freeze({ name: HARNESS_NAMES[name], binary }) : undefined;
}

function unavailable(context, reason) {
  return Object.freeze({
    environment: context.environment,
    ...(context.name ? { name: context.name, binary: context.binary } : {}),
    status: 'unavailable', reason,
  });
}

function probeCommand(selection) {
  if (!selection || !EXECUTABLE.test(selection.binary) ||
      selectHarness(selection.binary)?.name !== selection.name) {
    throw new Error('Invalid selected harness');
  }
  return `p=$(command -v '${selection.binary}') || exit 127; ` +
    `test -f "$p" && test -x "$p" || exit 126; printf '%s\\n' "$p"; "$p" --version`;
}

function parseProbe(context, result) {
  if (result.timedOut) return unavailable(context, 'probe_timed_out');
  if (result.overflow || Buffer.byteLength(result.stdout || '') > MAX_PROBE_BYTES) {
    return unavailable(context, 'probe_output_limit');
  }
  if (result.exitCode !== 0) return unavailable(context, result.exitCode === 127 ? 'binary_missing' : 'probe_failed');
  const lines = (result.stdout || '').trim().split(/\r?\n/);
  const binary = lines.shift();
  if (!binary || !EXECUTABLE.test(binary) ||
      binary.split('/').pop() !== context.binary?.split('/').pop() ||
      (context.binary?.includes('/') && binary !== context.binary)) {
    return unavailable(context, 'probe_output_invalid');
  }
  const patterns = {
    'copilot-cli': new RegExp(`^(?:GitHub Copilot CLI |copilot )?v?(${VERSION})$`),
    'claude-code': new RegExp(`^(${VERSION}) \\(Claude Code\\)$`),
    'codex-cli': new RegExp(`^codex-cli (${VERSION})$`),
  };
  const match = patterns[context.name]?.exec(lines[0] || '');
  if (!match || match[1].length > 128) return unavailable(context, 'probe_output_invalid');
  // Remaining informational lines (e.g. Copilot commit metadata) are discarded.
  return Object.freeze({
    environment: context.environment, name: context.name, binary: context.binary,
    resolvedBinary: binary, version: match[1], status: 'observed',
  });
}

function validateObservation(value, context) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unavailable(context, 'observation_invalid');
  const allowed = value.status === 'observed'
    ? ['environment', 'name', 'binary', 'status', 'version', 'resolvedBinary']
    : ['environment', 'name', 'binary', 'status', 'reason'];
  if (Object.keys(value).some(key => !allowed.includes(key))) return unavailable(context, 'observation_invalid');
  if (value.environment !== context.environment) return unavailable(context, 'observation_environment_mismatch');
  if (value.name !== context.name || value.binary !== context.binary) {
    return unavailable(context, 'observation_harness_mismatch');
  }
  if (value.status === 'unavailable' && REASONS.has(value.reason)) return unavailable(context, value.reason);
  if (!context.name || value.status !== 'observed' || typeof value.version !== 'string' ||
      !new RegExp(`^${VERSION}$`).test(value.version) || /\s/.test(value.version) || value.version.length > 128 ||
      typeof value.resolvedBinary !== 'string' || !EXECUTABLE.test(value.resolvedBinary) ||
      value.resolvedBinary.split('/').pop() !== context.binary?.split('/').pop() ||
      (context.binary?.includes('/') && value.resolvedBinary !== context.binary)) {
    return unavailable(context, 'observation_invalid');
  }
  return Object.freeze({
    environment: context.environment, name: context.name, binary: context.binary,
    resolvedBinary: value.resolvedBinary, status: 'observed', version: value.version,
  });
}

function eligibilityEvidence(report, scope) {
  const observed = report.status === 'observed';
  return {
    executionEnvironment: report.environment,
    ...(report.name ? { selectedHarness: report.name } : {}),
    observations: report.name ? [{
      scope: { ...scope }, name: report.name, environment: report.environment,
      version: observed ? report.version : '', verified: observed, actual: observed,
      ...(observed ? {} : { reason: report.reason }),
    }] : [],
  };
}

module.exports = {
  MAX_PROBE_BYTES, selectHarness, unavailable, probeCommand, parseProbe,
  validateObservation, eligibilityEvidence,
};
