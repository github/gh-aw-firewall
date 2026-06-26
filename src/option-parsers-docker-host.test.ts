import {
  checkDockerHost,
  resolveDockerHostPathPrefix,
} from './option-parsers';

describe('checkDockerHost', () => {
  it('should return valid when DOCKER_HOST is not set', () => {
    const result = checkDockerHost({});
    expect(result.valid).toBe(true);
  });

  it('should return valid when DOCKER_HOST is undefined', () => {
    const result = checkDockerHost({ DOCKER_HOST: undefined });
    expect(result.valid).toBe(true);
  });

  it('should return valid for the default /var/run/docker.sock socket', () => {
    const result = checkDockerHost({ DOCKER_HOST: 'unix:///var/run/docker.sock' });
    expect(result.valid).toBe(true);
  });

  it('should return valid for the /run/docker.sock socket', () => {
    const result = checkDockerHost({ DOCKER_HOST: 'unix:///run/docker.sock' });
    expect(result.valid).toBe(true);
  });

  it('should return valid for tcp://localhost (ARC/DinD standard endpoint)', () => {
    const result = checkDockerHost({ DOCKER_HOST: 'tcp://localhost:2375' });
    expect(result.valid).toBe(true);
  });

  it('should return valid for tcp://localhost on a non-default port', () => {
    const result = checkDockerHost({ DOCKER_HOST: 'tcp://localhost:2376' });
    expect(result.valid).toBe(true);
  });

  it('should return valid for tcp://127.0.0.1', () => {
    const result = checkDockerHost({ DOCKER_HOST: 'tcp://127.0.0.1:2375' });
    expect(result.valid).toBe(true);
  });

  it('should return invalid for a non-loopback TCP daemon (workflow-scope DinD)', () => {
    const result = checkDockerHost({ DOCKER_HOST: 'tcp://192.168.1.100:2375' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('tcp://192.168.1.100:2375');
      expect(result.error).toContain('external daemon');
      expect(result.error).toContain('network isolation model');
    }
  });

  it('should return invalid for a remote TCP daemon', () => {
    const result = checkDockerHost({ DOCKER_HOST: 'tcp://docker.example.com:2375' });
    expect(result.valid).toBe(false);
  });

  it('should return invalid for tcp://localhost without a port', () => {
    const result = checkDockerHost({ DOCKER_HOST: 'tcp://localhost' });
    expect(result.valid).toBe(false);
  });

  it('should return invalid for tcp://localhost with a path component', () => {
    const result = checkDockerHost({ DOCKER_HOST: 'tcp://localhost:2375/some/path' });
    expect(result.valid).toBe(false);
  });

  it('should return invalid for tcp://localhost with auth components', () => {
    const result = checkDockerHost({ DOCKER_HOST: '******localhost:2375' });
    expect(result.valid).toBe(false);
  });

  it('should return invalid for tcp://localhost with a non-numeric port', () => {
    const result = checkDockerHost({ DOCKER_HOST: 'tcp://localhost:abc' });
    expect(result.valid).toBe(false);
  });

  it('should return valid for a non-standard unix socket', () => {
    const result = checkDockerHost({ DOCKER_HOST: 'unix:///tmp/custom-docker.sock' });
    expect(result.valid).toBe(true);
  });
});

describe('resolveDockerHostPathPrefix', () => {
  it('returns explicit prefix when provided', () => {
    const result = resolveDockerHostPathPrefix({ valid: false, error: 'external DOCKER_HOST' }, '/daemon-root');
    expect(result).toEqual({ dockerHostPathPrefix: '/daemon-root', autoApplied: false, dindHint: false });
  });

  it('does not auto-apply a prefix for external DOCKER_HOST when none is provided', () => {
    const result = resolveDockerHostPathPrefix({ valid: false, error: 'external DOCKER_HOST' }, undefined);
    expect(result).toEqual({ dockerHostPathPrefix: undefined, autoApplied: false, dindHint: false });
  });

  it('returns undefined when DOCKER_HOST is local and no prefix is provided', () => {
    const result = resolveDockerHostPathPrefix({ valid: true }, undefined);
    expect(result).toEqual({ dockerHostPathPrefix: undefined, autoApplied: false, dindHint: false });
  });

  it('sets dindHint when DOCKER_HOST is a non-standard unix socket', () => {
    const result = resolveDockerHostPathPrefix(
      { valid: true },
      undefined,
      { DOCKER_HOST: 'unix:///tmp/docker-sibling.sock' },
    );
    expect(result).toEqual({ dockerHostPathPrefix: undefined, autoApplied: false, dindHint: true });
  });

  it('does not set dindHint for the default /var/run/docker.sock socket', () => {
    const result = resolveDockerHostPathPrefix(
      { valid: true },
      undefined,
      { DOCKER_HOST: 'unix:///var/run/docker.sock' },
    );
    expect(result).toEqual({ dockerHostPathPrefix: undefined, autoApplied: false, dindHint: false });
  });

  it('does not set dindHint for the /run/docker.sock socket', () => {
    const result = resolveDockerHostPathPrefix(
      { valid: true },
      undefined,
      { DOCKER_HOST: 'unix:///run/docker.sock' },
    );
    expect(result).toEqual({ dockerHostPathPrefix: undefined, autoApplied: false, dindHint: false });
  });

  it('sets dindHint when AWF_DIND=1 is set', () => {
    const result = resolveDockerHostPathPrefix(
      { valid: true },
      undefined,
      { AWF_DIND: '1' },
    );
    expect(result).toEqual({ dockerHostPathPrefix: undefined, autoApplied: false, dindHint: true });
  });

  it('does not set dindHint when AWF_DIND is not 1', () => {
    const result = resolveDockerHostPathPrefix(
      { valid: true },
      undefined,
      { AWF_DIND: '0' },
    );
    expect(result).toEqual({ dockerHostPathPrefix: undefined, autoApplied: false, dindHint: false });
  });

  it('sets dindHint for tcp://localhost (ARC/DinD sidecar endpoint)', () => {
    const result = resolveDockerHostPathPrefix(
      { valid: true },
      undefined,
      { DOCKER_HOST: 'tcp://localhost:2375' },
    );
    expect(result).toEqual({ dockerHostPathPrefix: undefined, autoApplied: false, dindHint: true });
  });

  it('sets dindHint for tcp://127.0.0.1 (ARC/DinD sidecar endpoint)', () => {
    const result = resolveDockerHostPathPrefix(
      { valid: true },
      undefined,
      { DOCKER_HOST: 'tcp://127.0.0.1:2375' },
    );
    expect(result).toEqual({ dockerHostPathPrefix: undefined, autoApplied: false, dindHint: true });
  });

  it('does not set dindHint for non-loopback TCP DOCKER_HOST', () => {
    const result = resolveDockerHostPathPrefix(
      { valid: false, error: 'external' },
      undefined,
      { DOCKER_HOST: 'tcp://192.168.1.100:2375' },
    );
    expect(result).toEqual({ dockerHostPathPrefix: undefined, autoApplied: false, dindHint: false });
  });

  it('explicit prefix wins and suppresses dindHint even when non-standard socket is set', () => {
    const result = resolveDockerHostPathPrefix(
      { valid: true },
      '/tmp/gh-aw',
      { DOCKER_HOST: 'unix:///tmp/docker-sibling.sock' },
    );
    expect(result).toEqual({ dockerHostPathPrefix: '/tmp/gh-aw', autoApplied: false, dindHint: false });
  });

  it('explicit prefix wins and suppresses dindHint when AWF_DIND=1', () => {
    const result = resolveDockerHostPathPrefix(
      { valid: true },
      '/host',
      { AWF_DIND: '1' },
    );
    expect(result).toEqual({ dockerHostPathPrefix: '/host', autoApplied: false, dindHint: false });
  });
});
