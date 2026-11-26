import {
  assertBoundedString,
  assertIdentityField,
  assertNamespaceLink,
  cgroupMembership,
  parseNumericFields,
  parseNumericLines,
  parseProcessStartTime,
  parseSingleNumericStatus,
  parseStatus,
  parseTaskIds,
  parseUnifiedCgroup,
  requiredStatus,
} from './confinement-proc-parsers';

describe('Cloud Hypervisor confinement proc parsers', () => {
  it('parses status fields and preserves empty supplementary groups', () => {
    const status = parseStatus('Name:\tvmm\nPid:\t4242\nGroups:\t\n');

    expect(status).toEqual({ Name: 'vmm', Pid: '4242', Groups: '' });
    expect(requiredStatus(status, 'Name', 4242)).toBe('vmm');
    expect(parseSingleNumericStatus(status, 'Pid', 4242)).toBe(4242);
    expect(parseNumericFields(status.Groups, 'Groups')).toEqual([]);
  });

  it('rejects malformed, duplicate, missing, and non-scalar status fields', () => {
    expect(() => parseStatus('Name vmm')).toThrow(/Malformed Cloud Hypervisor \/proc status line/);
    expect(() => parseStatus('Pid: 4242\nPid: 4243')).toThrow(/Duplicate.*field: Pid/);
    expect(() => requiredStatus({}, 'Pid', 4242)).toThrow(/missing \/proc status field Pid/);
    expect(() => requiredStatus({ Pid: '' }, 'Pid', 4242)).toThrow(/missing \/proc status field Pid/);
    expect(() => parseSingleNumericStatus({ Pid: '4242 4243' }, 'Pid', 4242))
      .toThrow(/has malformed Pid/);
  });

  it('parses numeric lines and requires four matching identity values', () => {
    expect(parseNumericLines('4242\n4243\n', 'cgroup.procs')).toEqual([4242, 4243]);
    expect(() => parseNumericFields('4242 invalid', 'Pid')).toThrow(/malformed Pid/);
    expect(() => assertIdentityField('1000 1000 1000 1000', 1000, 'UID', 4242)).not.toThrow();
    expect(() => assertIdentityField('1000 1000 0 1000', 1000, 'UID', 4242)).toThrow(/has UID values/);
    expect(() => assertIdentityField(undefined, 1000, 'UID', 4242)).toThrow(/has UID values none/);
  });

  it('sorts numeric task IDs and enforces the thread evidence bound', () => {
    expect(parseTaskIds(['4244', 'ignored', '4242', '4243'])).toEqual([4242, 4243, 4244]);
    expect(() => parseTaskIds(['ignored'])).toThrow(/found no process threads/);
    const tasks = Array.from({ length: 256 }, (_, index) => String(4242 + index));
    expect(parseTaskIds(tasks)).toHaveLength(256);
    expect(() => parseTaskIds([...tasks, '9999'])).toThrow(/exceeding the 256 thread evidence bound/);
  });

  it('parses start times after command names containing parentheses', () => {
    const stat = (startTime: string) =>
      `4242 (cloud (hypervisor)) ${['S', ...Array(18).fill('0'), startTime, '0'].join(' ')}`;

    expect(parseProcessStartTime(stat('98765'))).toBe('98765');
    expect(() => parseProcessStartTime('invalid')).toThrow(/Malformed Cloud Hypervisor \/proc stat/);
    expect(() => parseProcessStartTime(stat('invalid'))).toThrow(/Malformed.*start time/);
    expect(() => parseProcessStartTime(stat('9'.repeat(33)))).toThrow(/Malformed.*start time/);
  });

  it('requires unified cgroup membership under the cgroup root', () => {
    expect(parseUnifiedCgroup('0::/awf/run-1\n')).toBe('/awf/run-1');
    expect(cgroupMembership('/sys/fs/cgroup/awf/run-1')).toBe('/awf/run-1');
    expect(() => parseUnifiedCgroup('1:cpu:/awf/run-1')).toThrow(/not exclusively in a unified cgroup/);
    expect(() => parseUnifiedCgroup('0::/awf/run-1\n0::/other')).toThrow(/not exclusively/);
    expect(() => cgroupMembership('/sys/fs/cgroup')).toThrow(/Unsafe.*cgroup path/);
    expect(() => cgroupMembership('/sys/fs/other')).toThrow(/Unsafe.*cgroup path/);
  });

  it('requires a network namespace link and a byte-bounded evidence string', () => {
    expect(() => assertNamespaceLink('net:[4026533000]', 'network namespace')).not.toThrow();
    expect(() => assertNamespaceLink('mnt:[4026533000]', 'network namespace'))
      .toThrow(/Malformed network namespace/);
    expect(() => assertBoundedString('é'.repeat(2048), 'executable')).not.toThrow();
    expect(() => assertBoundedString('é'.repeat(2049), 'executable'))
      .toThrow(/exceeds the structured evidence bound/);
  });
});
