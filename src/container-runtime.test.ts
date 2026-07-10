import { resolveDockerRuntime, getRuntimeCapabilities, runtimeNeedsStaticDns } from './container-runtime';

describe('container-runtime', () => {
  describe('resolveDockerRuntime', () => {
    it('translates gvisor to runsc', () => {
      expect(resolveDockerRuntime('gvisor')).toBe('runsc');
    });

    it('passes through unknown runtime names unchanged', () => {
      expect(resolveDockerRuntime('kata')).toBe('kata');
      expect(resolveDockerRuntime('runsc')).toBe('runsc');
      expect(resolveDockerRuntime('custom-runtime')).toBe('custom-runtime');
    });
  });

  describe('getRuntimeCapabilities', () => {
    it('returns capabilities for known runtimes', () => {
      const caps = getRuntimeCapabilities('gvisor');
      expect(caps).toBeDefined();
      expect(caps!.dockerRuntime).toBe('runsc');
      expect(caps!.needsStaticDns).toBe(true);
    });

    it('returns undefined for unknown runtimes', () => {
      expect(getRuntimeCapabilities('kata')).toBeUndefined();
      expect(getRuntimeCapabilities('runsc')).toBeUndefined();
    });
  });

  describe('runtimeNeedsStaticDns', () => {
    it('returns true for gvisor', () => {
      expect(runtimeNeedsStaticDns('gvisor')).toBe(true);
    });

    it('returns false for unknown runtimes', () => {
      expect(runtimeNeedsStaticDns('kata')).toBe(false);
      expect(runtimeNeedsStaticDns('runsc')).toBe(false);
    });

    it('returns false for undefined/empty', () => {
      expect(runtimeNeedsStaticDns(undefined)).toBe(false);
      expect(runtimeNeedsStaticDns('')).toBe(false);
    });
  });
});
