'use strict';

const {
  ProductionTrustedCloudHypervisorEnclaveStorageProvider,
} = require('../../dist/cloud-hypervisor/trusted-enclave-storage');

// Exercise production admission, not a second implementation of host gates.
async function probeHostAdmission(provider = new ProductionTrustedCloudHypervisorEnclaveStorageProvider()) {
  let hostPreflight;
  try {
    await provider.assertAvailable({}, (progress) => { hostPreflight = progress; });
    return { schemaVersion: 1, perspective: 'preflight-harness', status: 'passed', hostPreflight };
  } catch {
    return { schemaVersion: 1, perspective: 'preflight-harness', status: 'failed', hostPreflight };
  }
}

if (require.main === module) {
  probeHostAdmission().then((result) => {
    console.log(`AWF_HOST_PREFLIGHT_PROBE ${JSON.stringify(result)}`);
    if (result.status !== 'passed') process.exitCode = 1;
  }, () => {
    console.error('AWF host preflight harness failed before diagnostic publication');
    process.exitCode = 1;
  });
}

module.exports = { probeHostAdmission };
