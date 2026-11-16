'use strict';

const RELEASE_ASSETS = [
  'cloud-hypervisor-test-x86_64.tar.gz',
  'cloud-hypervisor-test-x86_64.manifest.json',
  'cloud-hypervisor-test-x86_64.manifest.sigstore.jsonl',
  'cloud-hypervisor-enclave-rootfs-x86_64.manifest.json',
  'cloud-hypervisor-enclave-rootfs-x86_64.manifest.sigstore.jsonl',
  'enclave-rootfs.ext4',
  'enclave-rootfs.sbom.spdx.json',
  'enclave-rootfs.provenance.sigstore.jsonl',
];

const GATEWAY_IMAGE = 'awf-cloud-hypervisor-enclave-live-gateway:test';

const GATEWAY_CONTAINER = 'awmg-mcpg';

const SENTINEL_PREFIX = 'AWF_ENCLAVE_LIVE_OUTPUT_SENTINEL_';

const FAILURE_STAGES = Object.freeze({
  RUNNER: 'runner eligibility',
  CHECKOUT: 'acceptance checkout',
  PUBLIC_SEED_TOKENS: 'GH_TOKEN/GITHUB_TOKEN prerequisites',
  COPILOT_TOKEN: 'COPILOT_GITHUB_TOKEN prerequisite',
  RELEASE: 'release artifact setup',
  GATEWAY: 'gateway setup',
  BROKER: 'broker readiness',
  PRIMARY: 'primary VM readiness',
  PRIMARY_DOCKER: 'primary Docker readiness',
  MCP_ROUTE: 'public MCP route',
  SCRIPT: 'script enclave checks',
  AGENT: 'agent enclave checks',
  SCRIPT_ONLY: 'script-only profile acceptance',
  AGENT_ONLY: 'agent-only profile acceptance',
  RESOURCE_LIMITS: 'resource-limit checks',
  FAILURE_HANDLING: 'failure, timeout, and cancellation checks',
  STARTUP_FAULTS: 'startup fault checks',
  CRASH_RECOVERY: 'VMM crash recovery',
  OUTPUT_REDACTION: 'output redaction checks',
  CLEANUP: 'fixture cleanup',
});

module.exports = {
  RELEASE_ASSETS,
  GATEWAY_IMAGE,
  GATEWAY_CONTAINER,
  SENTINEL_PREFIX,
  FAILURE_STAGES,
};
