import * as path from 'path';

const CGROUP_ROOT = '/sys/fs/cgroup';
const MAX_VERIFIED_THREADS = 256;
const MAX_EVIDENCE_STRING_LENGTH = 4096;

export function parseStatus(contents: string): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const line of contents.split('\n')) {
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator <= 0) throw new Error(`Malformed Cloud Hypervisor /proc status line: ${line}`);
    const key = line.slice(0, separator);
    if (result[key] !== undefined) throw new Error(`Duplicate Cloud Hypervisor /proc status field: ${key}`);
    result[key] = line.slice(separator + 1).trim();
  }
  return result;
}

export function requiredStatus(
  status: Readonly<Record<string, string>>,
  field: string,
  taskId: number,
): string {
  const value = status[field];
  if (value === undefined || value === '') {
    throw new Error(`Cloud Hypervisor thread ${taskId} is missing /proc status field ${field}`);
  }
  return value;
}

export function assertIdentityField(
  value: string | undefined,
  expected: number,
  label: string,
  taskId: number,
): void {
  const observed = parseNumericFields(
    value ?? '',
    `${label} for thread ${taskId}`,
  );
  if (observed.length !== 4 || observed.some((entry) => entry !== expected)) {
    throw new Error(
      `Cloud Hypervisor thread ${taskId} has ${label} values ${observed.join(',') || 'none'}, ` +
      `expected four instances of ${expected}`,
    );
  }
}

export function parseSingleNumericStatus(
  status: Readonly<Record<string, string>>,
  field: string,
  taskId: number,
): number {
  const values = parseNumericFields(requiredStatus(status, field, taskId), field);
  if (values.length !== 1) {
    throw new Error(`Cloud Hypervisor thread ${taskId} has malformed ${field}`);
  }
  return values[0];
}

export function parseNumericFields(value: string, label: string): number[] {
  const fields = value.trim().split(/\s+/).filter(Boolean);
  if (fields.some((field) => !/^\d+$/.test(field))) {
    throw new Error(`Cloud Hypervisor confinement verification found malformed ${label}: ${value}`);
  }
  return fields.map(Number);
}

export function parseNumericLines(value: string, label: string): number[] {
  return parseNumericFields(value.replace(/\n/g, ' '), label);
}

export function parseTaskIds(entries: readonly string[]): number[] {
  const taskIds = entries
    .filter((entry) => /^\d+$/.test(entry))
    .map(Number)
    .sort((left, right) => left - right);
  if (taskIds.length === 0) {
    throw new Error('Cloud Hypervisor confinement verification found no process threads');
  }
  if (taskIds.length > MAX_VERIFIED_THREADS) {
    throw new Error(
      `Cloud Hypervisor confinement verification found ${taskIds.length} threads, ` +
      `exceeding the ${MAX_VERIFIED_THREADS} thread evidence bound`,
    );
  }
  return taskIds;
}

export function parseProcessStartTime(stat: string): string {
  const commandEnd = stat.lastIndexOf(')');
  if (commandEnd < 2) throw new Error('Malformed Cloud Hypervisor /proc stat contents');
  const fieldsAfterCommand = stat.slice(commandEnd + 2).trim().split(/\s+/);
  const startTime = fieldsAfterCommand[19];
  if (!startTime || !/^\d+$/.test(startTime) || startTime.length > 32) {
    throw new Error('Malformed Cloud Hypervisor process start time');
  }
  return startTime;
}

export function parseUnifiedCgroup(contents: string): string {
  const lines = contents.trim().split('\n');
  if (lines.length !== 1 || !lines[0].startsWith('0::/')) {
    throw new Error(`Cloud Hypervisor process is not exclusively in a unified cgroup: ${contents.trim()}`);
  }
  return lines[0].slice(3);
}

export function cgroupMembership(cgroupPath: string): string {
  const relative = path.relative(CGROUP_ROOT, cgroupPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Unsafe Cloud Hypervisor cgroup path: ${cgroupPath}`);
  }
  return `/${relative}`;
}

export function assertNamespaceLink(value: string, label: string): void {
  if (!/^net:\[\d+\]$/.test(value)) {
    throw new Error(`Malformed ${label}: ${JSON.stringify(value)}`);
  }
}

export function assertBoundedString(value: string, label: string): void {
  if (Buffer.byteLength(value) > MAX_EVIDENCE_STRING_LENGTH) {
    throw new Error(`Cloud Hypervisor ${label} exceeds the structured evidence bound`);
  }
}
