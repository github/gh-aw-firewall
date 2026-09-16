export const CLOUD_HYPERVISOR_UNSUPPORTED_HOST = 'CLOUD_HYPERVISOR_UNSUPPORTED_HOST';

export class CloudHypervisorUnsupportedHostError extends Error {
  readonly code = CLOUD_HYPERVISOR_UNSUPPORTED_HOST;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'CloudHypervisorUnsupportedHostError';
    if (cause !== undefined) Object.defineProperty(this, 'cause', { value: cause });
  }
}

export function formatCloudHypervisorErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatCloudHypervisorDockerFallbackWarning(error: unknown): string {
  return '[cloud-hypervisor] unsupported host detected; falling back to the standard Docker backend. ' +
    formatCloudHypervisorErrorMessage(error);
}

export function isCloudHypervisorUnsupportedHostError(
  error: unknown,
): error is CloudHypervisorUnsupportedHostError {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === CLOUD_HYPERVISOR_UNSUPPORTED_HOST,
  );
}
