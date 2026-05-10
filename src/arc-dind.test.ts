import {
  ARC_DIND_BIND_PREFIX,
  detectArcDindDockerHost,
  translateArcDindBindSource,
} from './arc-dind';

describe('detectArcDindDockerHost', () => {
  it('does not flag an unset docker host', () => {
    expect(detectArcDindDockerHost({})).toEqual({ detected: false });
  });

  it('does not flag default local docker sockets', () => {
    expect(detectArcDindDockerHost({ DOCKER_HOST: 'unix:///var/run/docker.sock' })).toEqual({ detected: false });
    expect(detectArcDindDockerHost({ DOCKER_HOST: 'unix:///run/docker.sock' })).toEqual({ detected: false });
  });

  it('flags non-default unix sockets as ARC/DinD candidates', () => {
    expect(detectArcDindDockerHost({ DOCKER_HOST: 'unix:///run/user/1000/docker.sock' })).toEqual({
      detected: true,
      dockerHost: 'unix:///run/user/1000/docker.sock',
      reason: 'non-default-unix-socket',
    });
  });

  it('flags tcp docker hosts as ARC/DinD candidates', () => {
    expect(detectArcDindDockerHost({ DOCKER_HOST: 'tcp://localhost:2375' })).toEqual({
      detected: true,
      dockerHost: 'tcp://localhost:2375',
      reason: 'tcp',
    });
  });
});

describe('translateArcDindBindSource', () => {
  it('rewrites absolute host paths under the ARC/DinD staging prefix', () => {
    expect(translateArcDindBindSource('/etc/passwd')).toBe(`${ARC_DIND_BIND_PREFIX}/etc/passwd`);
    expect(translateArcDindBindSource('/tmp/awf-test/logs')).toBe(`${ARC_DIND_BIND_PREFIX}/tmp/awf-test/logs`);
    expect(translateArcDindBindSource('/')).toBe(ARC_DIND_BIND_PREFIX);
  });

  it('leaves daemon-local passthrough paths unchanged', () => {
    expect(translateArcDindBindSource('/sys')).toBe('/sys');
    expect(translateArcDindBindSource('/dev/null')).toBe('/dev/null');
    expect(translateArcDindBindSource('/var/run/docker.sock')).toBe('/var/run/docker.sock');
  });

  it('leaves relative paths unchanged', () => {
    expect(translateArcDindBindSource('relative/path')).toBe('relative/path');
  });

  it('leaves Windows-style absolute paths unchanged', () => {
    expect(translateArcDindBindSource('C:\\awf\\workdir')).toBe('C:\\awf\\workdir');
  });
});
