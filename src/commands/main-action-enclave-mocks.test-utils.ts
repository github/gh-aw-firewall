import './main-action-mocks.test-utils';

jest.mock('../resolved-config-artifact');
jest.mock('../enclave/gateway');
jest.mock('../enclave/startup-diagnostics');
jest.mock('../enclave/github-gateway');
jest.mock('../enclave/cloud-hypervisor-lifecycle');
jest.mock('../enclave/docker-lifecycle');
jest.mock('../enclave/dynamic-delegation');
jest.mock('../enclave/manager', () => ({
  ...jest.requireActual('../enclave/manager'),
  prepareEnclaves: jest.fn(),
}));
jest.mock('../external-runtime-backend-resolver', () => {
  const actual = jest.requireActual('../external-runtime-backend-resolver');
  return {
    ...actual,
    resolveExternalRuntimeBackend: jest.fn(actual.resolveExternalRuntimeBackend),
  };
});
jest.mock('../services/agent-volumes/credential-hiding', () => ({
  ...jest.requireActual('../services/agent-volumes/credential-hiding'),
  buildCredentialHidingOverlays: jest.fn(() => []),
}));
