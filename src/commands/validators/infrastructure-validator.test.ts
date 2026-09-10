import {
  callAssembleWith,
  getMockExit,
  logger,
  mockBuildConfigOnce,
  setupConfigAssemblyTestSuite,
} from './config-assembly.test-utils';

describe('config-assembly', () => {
  setupConfigAssemblyTestSuite();

  describe('--network-subnet runtime scope guard', () => {
    it('rejects --network-subnet with --container-runtime sbx', () => {
      mockBuildConfigOnce({ networkSubnet: '10.88.0.0/24', containerRuntime: 'sbx' });

      expect(() => {
        callAssembleWith();
      }).toThrow('process.exit(1)');

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('--network-subnet is not supported with --container-runtime sbx'),
      );
    });

    it('rejects --network-subnet with --container-runtime cloud-hypervisor', () => {
      mockBuildConfigOnce({ networkSubnet: '10.88.0.0/24', containerRuntime: 'cloud-hypervisor' });

      expect(() => {
        callAssembleWith();
      }).toThrow('process.exit(1)');

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('--network-subnet is not supported with --container-runtime cloud-hypervisor'),
      );
    });

    it('accepts --network-subnet with a compose runtime (no containerRuntime override)', () => {
      mockBuildConfigOnce({ networkSubnet: '10.88.0.0/24' });

      expect(() => {
        callAssembleWith();
      }).not.toThrow();

      expect(getMockExit()).not.toHaveBeenCalled();
    });

    it('accepts --container-runtime sbx without --network-subnet', () => {
      mockBuildConfigOnce({ containerRuntime: 'sbx' });

      expect(() => {
        callAssembleWith();
      }).not.toThrow();

      expect(getMockExit()).not.toHaveBeenCalled();
    });
  });
});
