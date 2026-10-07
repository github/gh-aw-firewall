import {
  assertBoundedEnclaveStorage,
  assertBoundedEnclaveWritableExports,
  mountBoundedEnclaveStorage,
  type EnclaveStorageDependencies,
} from './enclave-storage';
import { CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES as profiles } from './workload-profile';

const directory = '/trusted/invocations/script/0123456789abcdef0123456789abcdef';
const mountInfo = (point = directory, device = '0:42') =>
  `30 29 ${device} / ${point} rw,nosuid,nodev,noexec - tmpfs awf-enclave-invocation rw,size=1048576k`;

function dependencies(
  size = profiles.script.writableStorageBytes,
  overrides: Partial<EnclaveStorageDependencies> = {},
): EnclaveStorageDependencies {
  return {
    realpath: jest.fn(async (value) => value),
    lstat: jest.fn().mockResolvedValue({ uid: 65534, gid: 65534, mode: 0o40700 }),
    readMountInfo: jest.fn().mockResolvedValue(mountInfo()),
    statfs: jest.fn().mockResolvedValue({
      type: 0x01021994n, blocks: BigInt(size / 4096), bsize: 4096n,
    }),
    ...overrides,
  };
}

describe('bounded enclave storage verification', () => {
  it.each(['script', 'agent'] as const)('accepts only the exact %s aggregate budget', async (role) => {
    const size = profiles[role].writableStorageBytes;
    const deps = dependencies(size);
    const exports = ['output', 'runtime', ...(role === 'agent' ? ['session-state'] : [])]
      .map((name) => `${directory}/${name}`);
    await expect(assertBoundedEnclaveStorage(directory, size, exports, deps)).resolves.toBeUndefined();
    expect(deps.statfs).toHaveBeenCalledTimes(exports.length + 1);
    expect(deps.readMountInfo).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, 4096, NaN, Infinity])('rejects non-role size %s', async (size) => {
    await expect(assertBoundedEnclaveStorage(directory, size, [], dependencies()))
      .rejects.toThrow(/role capacity/);
  });

  it.each([
    ['missing mount', ''],
    ['host filesystem', mountInfo().replace('tmpfs', 'ext4')],
    ['foreign mount', mountInfo().replace('awf-enclave-invocation', 'tmpfs')],
    ['bind mount root', mountInfo().replace(' / ', ' /subdirectory ')],
    ['stacked mount', `${mountInfo()}\n${mountInfo()}`],
    ['nested mount', `${mountInfo()}\n${mountInfo(`${directory}/runtime`, '0:43')}`],
    ['external alias', `${mountInfo()}\n${mountInfo('/another/invocation')}`],
    ['missing noexec', mountInfo().replace(',noexec', '')],
    ['read-only mount', mountInfo().replace('rw,nosuid', 'ro,nosuid')],
  ])('rejects %s rather than falling back', async (_label, info) => {
    await expect(assertBoundedEnclaveStorage(directory, profiles.script.writableStorageBytes, [], dependencies(
      undefined, { readMountInfo: async () => info },
    ))).rejects.toThrow(/mount/);
  });

  it.each([512 * 1024 * 1024, 2 * 1024 * 1024 * 1024])('rejects incorrectly sized storage %s', async (size) => {
    await expect(assertBoundedEnclaveStorage(
      directory, profiles.script.writableStorageBytes, [], dependencies(size),
    )).rejects.toThrow(/capacity/);
  });

  it('rejects non-tmpfs statfs even when capacity matches', async () => {
    await expect(assertBoundedEnclaveStorage(
      directory, profiles.script.writableStorageBytes, [], dependencies(undefined, {
        statfs: async () => ({
          type: 0xef53n, blocks: 262144n, bsize: 4096n,
        }),
      }),
    )).rejects.toThrow(/capacity/);
  });

  it.each([
    '/', 'relative/path', `${directory}/../elsewhere`,
  ])('rejects untrusted invocation path %s', async (value) => {
    await expect(assertBoundedEnclaveStorage(
      value, profiles.script.writableStorageBytes, [], dependencies(),
    )).rejects.toThrow(/identity/);
  });

  it.each([
    '/another/invocation/output', `${directory}/../output`, `${directory}/runtime/child`,
  ])('rejects an export outside the closed invocation layout: %s', async (value) => {
    await expect(assertBoundedEnclaveStorage(
      directory, profiles.script.writableStorageBytes, [value], dependencies(),
    )).rejects.toThrow(/escapes/);
  });

  it('rejects symlinked invocation directories and exports', async () => {
    const deps = dependencies(undefined, { realpath: async () => '/untrusted/elsewhere' });
    await expect(assertBoundedEnclaveStorage(directory, profiles.script.writableStorageBytes, [], deps))
      .rejects.toThrow(/identity/);
    await expect(assertBoundedEnclaveStorage(directory, profiles.script.writableStorageBytes,
      [`${directory}/output`], dependencies(undefined, {
        realpath: async (value) => value === directory ? value : '/untrusted/elsewhere',
      }))).rejects.toThrow(/escapes/);
  });

  it('propagates unverifiable kernel evidence', async () => {
    await expect(assertBoundedEnclaveStorage(
      directory, profiles.script.writableStorageBytes, [], dependencies(undefined, {
        readMountInfo: async () => { throw new Error('mountinfo unavailable'); },
      }),
    )).rejects.toThrow('mountinfo unavailable');
  });

  it.each([
    { uid: 0, gid: 65534, mode: 0o40700 },
    { uid: 65534, gid: 0, mode: 0o40700 },
    { uid: 65534, gid: 65534, mode: 0o40777 },
  ])('rejects incorrect mount ownership %j', async (identity) => {
    await expect(assertBoundedEnclaveStorage(
      directory, profiles.script.writableStorageBytes, [], dependencies(undefined, {
        lstat: async () => identity,
      }),
    )).rejects.toThrow(/ownership/);
  });

  it('requires writable exports', async () => {
    await expect(assertBoundedEnclaveWritableExports([], profiles.script.writableStorageBytes))
      .rejects.toThrow(/requires bounded writable exports/);
  });

  it('rejects caller-selectable sizes or identities before mounting', async () => {
    await expect(mountBoundedEnclaveStorage(directory, 4096, 65534, 65534, { mount: '/usr/bin/false' }))
      .rejects.toThrow(/closed role profile/);
    await expect(mountBoundedEnclaveStorage(directory, profiles.script.writableStorageBytes,
      0, 0, { mount: '/usr/bin/false' })).rejects.toThrow(/closed role profile/);
  });
});
