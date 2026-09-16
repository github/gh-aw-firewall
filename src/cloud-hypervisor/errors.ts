export const CLOUD_HYPERVISOR_UNSUPPORTED_HOST = 'CLOUD_HYPERVISOR_UNSUPPORTED_HOST';

export class CloudHypervisorUnsupportedHostError extends Error {
  readonly code = CLOUD_HYPERVISOR_UNSUPPORTED_HOST;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'CloudHypervisorUnsupportedHostError';
    if (cause !== undefined) Object.defineProperty(this, 'cause', { value: cause });
  }
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
