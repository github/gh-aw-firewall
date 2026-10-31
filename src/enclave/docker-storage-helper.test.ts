import { execFileSync } from 'child_process';
import * as path from 'path';
import {
  dockerHelperStorageTarget, dockerStorageHelperArguments, DOCKER_ENCLAVE_MAX_HOST_BYTES,
} from './docker-storage-helper';

describe('narrow Docker enclave storage helper', () => {
  const run = 'a'.repeat(32);
  const invocation = 'b'.repeat(32);
  const source = `awf-enclave-${run}-agent-${invocation}`;
  const target = dockerHelperStorageTarget(run, 'agent', invocation);

  test('derives only fixed per-caller allocations', () => {
    expect(target).toBe(`/var/lib/awf/enclave-storage/${process.getuid?.()}/${run}-agent/${invocation}`);
    expect(dockerStorageHelperArguments('mount', target, source, 65536))
      .toEqual(['mount', `${run}-agent/${invocation}`, source, '65536']);
  });

  test.each([
    ['/etc', source, 65536],
    [target.replace(`/${process.getuid?.()}/`, `/${(process.getuid?.() || 0) + 1}/`), source, 65536],
    [`${target}/../${invocation}`, source, 65536],
    [target, 'foreign', 65536],
    [target, source, DOCKER_ENCLAVE_MAX_HOST_BYTES + 4096],
    [target, source, 4097],
  ])('rejects non-authoritative allocation requests', (location, mountSource, bytes) => {
    expect(() => dockerStorageHelperArguments('mount', String(location), String(mountSource), Number(bytes))).toThrow();
  });

  (process.platform === 'linux' ? test : test.skip)('runs the helper filesystem and recovery policy tests without privilege', () => {
    expect(() => execFileSync('/usr/bin/python3', [
      '-I', path.resolve(__dirname, '../../scripts/enclave-storage-helper.test.py'),
    ], { cwd: path.resolve(__dirname, '../..'), env: { PATH: '/usr/bin:/bin' }, stdio: 'pipe' })).not.toThrow();
  });
});
