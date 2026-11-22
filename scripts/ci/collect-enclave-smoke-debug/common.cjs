/* global module */
const MAX_STREAM_BYTES = 1024 * 1024;
const MAX_FILES = 32;
const MAX_RUN_PROJECTION_FILES = 4;
const MAX_STATUS_BYTES = 4096;
const MAX_STARTUP_BYTES = 64 * 1024;
const MAX_PUBLISHED_FILES = MAX_FILES + MAX_RUN_PROJECTION_FILES + 3;
const MAX_PUBLISHED_BYTES = (MAX_FILES + MAX_RUN_PROJECTION_FILES) * MAX_STREAM_BYTES + 2 * MAX_STATUS_BYTES + MAX_STARTUP_BYTES;
const MAX_DIRECTORY_ENTRIES = 4096;
const MAX_USAGE_BYTES = 16 * 1024;
const ID = /^[a-f0-9]{32}$/;
const INVOCATION_ID = /^[a-f0-9]{16,64}$/;
const ENTRY_ID = /^[a-z0-9](?:[a-z0-9-]{0,62})$/;
const LOG_NAME = /^(?:(?:stdout|stderr)\.log|diagnostics\.json|retention-unavailable\.json|enclave-session\.log|enclave-proxy-events\.jsonl|enclave-proxy-container\.log|launcher-(?:stdout|stderr)\.log|guest-(?:stdout|stderr)\.raw\.log|cloud-hypervisor\.log|serial\.log|network-plan\.json|network-diagnostics\.txt|counters\.json|vm-info\.json|runtime\.json|confinement\.json|virtiofs-[0-9]-enclave-(?:seed|request|output|runtime|session-handoff|session-state)(?:\.log|-confinement\.json))$/;
const ROOTS = {
  journal: '/var/lib/awf-cloud-hypervisor/host-executor-journal',
  debug: '/var/lib/awf-cloud-hypervisor/debug-artifacts/cloud-hypervisor',
};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function check(condition, failedCheck, category = 'invalid-evidence') {
  if (!condition) {
    const error = new Error(`Debug collection rejected: ${failedCheck}`);
    error.failedCheck = failedCheck;
    error.category = category;
    throw error;
  }
}

function parseRecord(line) {
  try {
    const record = JSON.parse(line);
    return record && typeof record === 'object' && !Array.isArray(record) ? record : undefined;
  } catch {
    return undefined;
  }
}

module.exports = {
  MAX_STREAM_BYTES, MAX_FILES, MAX_STATUS_BYTES, MAX_STARTUP_BYTES, MAX_PUBLISHED_FILES,
  MAX_PUBLISHED_BYTES, MAX_DIRECTORY_ENTRIES, MAX_USAGE_BYTES, ID, INVOCATION_ID, ENTRY_ID,
  LOG_NAME, ROOTS, object, check, parseRecord,
};
