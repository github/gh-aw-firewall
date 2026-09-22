import { constants, promises as fs } from 'fs';
import execa from 'execa';
import {
  buildExecutionFailureDiagnostics,
  describeMountForPath,
  findMountForPath,
  pathComponents,
  resolveDiagnosticGetfaclPath,
} from './preflight-diagnostics';

jest.mock('execa');

const mockedExeca = execa as jest.MockedFunction<typeof execa>;

describe('Cloud Hypervisor preflight diagnostics', () => {
  beforeEach(() => {
    mockedExeca.mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('finds the most specific mount containing a path', () => {
    expect(findMountForPath(
      '25 1 0:24 / / rw,relatime - ext4 /dev/root rw\n' +
      '26 25 0:25 / /snapshot rw,nosuid,nodev,noexec - tmpfs tmpfs rw\n',
      '/snapshot/cloud-hypervisor',
    )).toMatchObject({
      mountPoint: '/snapshot',
      filesystemType: 'tmpfs',
      source: 'tmpfs',
      options: 'rw,nosuid,nodev,noexec',
    });
  });

  it('describes mount and path diagnostics for execution failures', async () => {
    (mockedExeca as unknown as jest.Mock).mockImplementation(async (command: string) => {
      if (command === '/usr/bin/getfacl') {
        return {
          exitCode: 0,
          stdout: 'user::rwx\ngroup::r-x',
          stderr: '',
        } as never;
      }
      throw new Error(`unexpected command: ${command}`);
    });
    jest.spyOn(fs, 'access').mockImplementation(async (target, mode) => {
      expect(target).toBe('/usr/bin/getfacl');
      expect(mode).toBe(constants.X_OK);
    });
    jest.spyOn(fs, 'readFile').mockImplementation(async (filePath) => {
      if (filePath === '/proc/self/mountinfo') {
        return '25 1 0:24 / / rw,relatime - ext4 /dev/root rw\n' +
          '26 25 0:25 / /snapshot rw,nosuid,nodev,noexec - tmpfs tmpfs rw\n';
      }
      throw new Error(`unexpected read: ${String(filePath)}`);
    });
    jest.spyOn(fs, 'lstat').mockResolvedValue({
      isSymbolicLink: () => false,
      isDirectory: () => false,
      isFile: () => true,
      mode: 0o100555,
      uid: 0,
      gid: 0,
      size: 1,
    } as never);

    await expect(describeMountForPath('/snapshot/cloud-hypervisor')).resolves.toBe(
      'mount: /snapshot type=tmpfs source=tmpfs options=rw,nosuid,nodev,noexec',
    );
    await expect(resolveDiagnosticGetfaclPath()).resolves.toBe('/usr/bin/getfacl');
    expect(pathComponents('/snapshot/cloud-hypervisor')).toEqual([
      '/',
      '/snapshot',
      '/snapshot/cloud-hypervisor',
    ]);
    await expect(buildExecutionFailureDiagnostics('/snapshot/cloud-hypervisor')).resolves.toMatch(
      /Cloud Hypervisor execution diagnostics:[\s\S]*mount: \/snapshot type=tmpfs source=tmpfs options=rw,nosuid,nodev,noexec[\s\S]*acl=user::rwx group::r-x/,
    );
  });
});
