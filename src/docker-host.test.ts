import { setAwfDockerHost, getLocalDockerEnv } from './docker-host';

describe('docker-host', () => {
  let originalDockerHost: string | undefined;

  beforeEach(() => {
    originalDockerHost = process.env.DOCKER_HOST;
    // Reset the module-level override between tests
    setAwfDockerHost(undefined);
  });

  afterEach(() => {
    // Restore original DOCKER_HOST
    if (originalDockerHost === undefined) {
      delete process.env.DOCKER_HOST;
    } else {
      process.env.DOCKER_HOST = originalDockerHost;
    }
    setAwfDockerHost(undefined);
  });

  describe('getLocalDockerEnv', () => {
    describe('when no override is set and no DOCKER_HOST in environment', () => {
      it('should return environment without DOCKER_HOST', () => {
        delete process.env.DOCKER_HOST;
        const env = getLocalDockerEnv();
        expect(env.DOCKER_HOST).toBeUndefined();
      });

      it('should include other environment variables', () => {
        delete process.env.DOCKER_HOST;
        process.env.HOME = '/home/testuser';
        const env = getLocalDockerEnv();
        expect(env.HOME).toBe('/home/testuser');
      });
    });

    describe('when DOCKER_HOST is a unix socket', () => {
      it('should preserve unix:// DOCKER_HOST', () => {
        process.env.DOCKER_HOST = 'unix:///var/run/docker.sock';
        const env = getLocalDockerEnv();
        expect(env.DOCKER_HOST).toBe('unix:///var/run/docker.sock');
      });

      it('should preserve custom unix socket paths', () => {
        process.env.DOCKER_HOST = 'unix:///run/user/1000/docker.sock';
        const env = getLocalDockerEnv();
        expect(env.DOCKER_HOST).toBe('unix:///run/user/1000/docker.sock');
      });
    });

    describe('when DOCKER_HOST is a TCP address (DinD)', () => {
      it('should remove tcp:// DOCKER_HOST to use local daemon', () => {
        process.env.DOCKER_HOST = 'tcp://localhost:2375';
        const env = getLocalDockerEnv();
        expect(env.DOCKER_HOST).toBeUndefined();
      });

      it('should remove tcp:// DOCKER_HOST with remote address', () => {
        process.env.DOCKER_HOST = 'tcp://dind-sidecar:2376';
        const env = getLocalDockerEnv();
        expect(env.DOCKER_HOST).toBeUndefined();
      });

      it('should not modify the original process.env.DOCKER_HOST', () => {
        process.env.DOCKER_HOST = 'tcp://localhost:2375';
        getLocalDockerEnv();
        // Original process.env should be unchanged
        expect(process.env.DOCKER_HOST).toBe('tcp://localhost:2375');
      });
    });
  });

  describe('setAwfDockerHost', () => {
    describe('when override is set', () => {
      it('should use override value even when DOCKER_HOST is tcp', () => {
        process.env.DOCKER_HOST = 'tcp://dind-sidecar:2376';
        setAwfDockerHost('unix:///var/run/docker-override.sock');
        const env = getLocalDockerEnv();
        expect(env.DOCKER_HOST).toBe('unix:///var/run/docker-override.sock');
      });

      it('should use override value when no DOCKER_HOST is set', () => {
        delete process.env.DOCKER_HOST;
        setAwfDockerHost('unix:///custom/docker.sock');
        const env = getLocalDockerEnv();
        expect(env.DOCKER_HOST).toBe('unix:///custom/docker.sock');
      });

      it('should allow override to be a tcp address', () => {
        delete process.env.DOCKER_HOST;
        setAwfDockerHost('tcp://custom-daemon:2375');
        const env = getLocalDockerEnv();
        expect(env.DOCKER_HOST).toBe('tcp://custom-daemon:2375');
      });
    });

    describe('when override is cleared', () => {
      it('should fall back to environment-based detection after clearing override', () => {
        setAwfDockerHost('unix:///custom.sock');
        setAwfDockerHost(undefined);

        process.env.DOCKER_HOST = 'tcp://localhost:2375';
        const env = getLocalDockerEnv();
        // Should remove tcp:// host since override was cleared
        expect(env.DOCKER_HOST).toBeUndefined();
      });
    });
  });
});
