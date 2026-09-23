import { promises as fs } from 'fs';
import { createDefaultIdentityDependencies } from './identity-dependencies';

describe('createDefaultIdentityDependencies', () => {
  it('creates the shared filesystem and process dependency scaffold', async () => {
    const processStartTime = jest.fn().mockResolvedValue('123');
    const dependencies = createDefaultIdentityDependencies(processStartTime);

    expect(dependencies).toMatchObject({
      mkdir: fs.mkdir,
      writeFile: fs.writeFile,
      readFile: fs.readFile,
      rm: fs.rm,
      rmdir: fs.rmdir,
      lstat: fs.lstat,
      pid: process.pid,
      processStartTime,
    });
    const result = await dependencies.run(process.execPath, [
      '-e',
      'process.stdout.write(process.env.PATH ?? "")',
    ]);
    expect(result.stdout).toBe('/usr/sbin:/usr/bin:/sbin:/bin');
    await expect(dependencies.run(process.execPath, ['-e', 'process.exit(1)']))
      .rejects.toThrow(/exited with code 1/);
    await expect(dependencies.sleep(0)).resolves.toBeUndefined();
  });
});
