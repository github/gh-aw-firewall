import { buildOpenvmmSeccompFilter, DENIED_X86_64_SYSCALLS } from './openvmm-seccomp';

function evaluateFilter(filter: Buffer, syscall: number, arch = 0xc000003e): number {
  let accumulator = 0;
  for (let offset = 0; offset < filter.length; offset += 8) {
    const code = filter.readUInt16LE(offset);
    const value = filter.readUInt32LE(offset + 4);
    if (code === 0x20) {
      accumulator = value === 4 ? arch : syscall;
    } else if (code === 0x15 || code === 0x45) {
      const matches = code === 0x15 ? accumulator === value : (accumulator & value) !== 0;
      offset += filter.readUInt8(offset + (matches ? 2 : 3)) * 8;
    } else if (code === 0x06) {
      return value;
    } else {
      throw new Error(`Unexpected seccomp instruction: ${code}`);
    }
  }
  throw new Error('Seccomp filter did not return a verdict');
}

describe('OpenVMM seccomp filter', () => {
  it.each([false, true])('preserves the denylist with allowCallerMount=%s', (allowCallerMount) => {
    const filter = buildOpenvmmSeccompFilter(allowCallerMount);
    for (const syscall of DENIED_X86_64_SYSCALLS) {
      expect(evaluateFilter(filter, syscall)).toBe(0x00050001);
    }
    for (const syscall of [0, 1, 60]) {
      expect(evaluateFilter(filter, syscall)).toBe(0x7fff0000);
    }
    for (const syscall of [122, 123]) {
      expect(evaluateFilter(filter, syscall)).toBe(allowCallerMount ? 0x7fff0000 : 0x00050001);
    }
  });

  it.each([false, true])('rejects other ABIs with allowCallerMount=%s', (allowCallerMount) => {
    const filter = buildOpenvmmSeccompFilter(allowCallerMount);
    expect(evaluateFilter(filter, 0, 0x40000003)).toBe(0x80000000);
    expect(evaluateFilter(filter, 0x40000000)).toBe(0x00050001);
    expect(evaluateFilter(filter, 0x40000000 | 165)).toBe(0x00050001);
  });
});
