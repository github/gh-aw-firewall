export function validatePositiveInteger(name: string, value: number, errors: string[]): void {
  if (!Number.isSafeInteger(value) || value < 1) errors.push(`${name} must be a positive integer`);
}

export function validateResourceLimits(
  name: string,
  executor: {
    memoryLimit: string;
    cpuLimit: string;
    pidsLimit: number;
    tmpfsLimit: string;
    maxOutputBytes: number;
  },
  errors: string[],
): void {
  const dockerSize = /^[1-9][0-9]*[bkmgBKMG]$/;
  if (!dockerSize.test(executor.memoryLimit)) errors.push(`${name}.memoryLimit is not a Docker size`);
  if (!dockerSize.test(executor.tmpfsLimit)) errors.push(`${name}.tmpfsLimit is not a Docker size`);
  if (!/^(?:[0-9]{1,2})(?:\.[0-9]{1,3})?$/.test(executor.cpuLimit) || Number(executor.cpuLimit) <= 0) {
    errors.push(`${name}.cpuLimit must be a positive Docker --cpus value`);
  }
  validatePositiveInteger(`${name}.pidsLimit`, executor.pidsLimit, errors);
  validatePositiveInteger(`${name}.maxOutputBytes`, executor.maxOutputBytes, errors);
}
