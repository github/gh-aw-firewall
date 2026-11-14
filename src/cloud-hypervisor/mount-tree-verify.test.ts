import { assertMountToolSupported, MountTreeVerifier, remountOptionsSatisfied } from './mount-tree-verify';
import type { ResolvedOverlay } from './mount-tree-verify';
import type { MountTreeStats } from './mount-tree';

const rootPath = '/run/staged';
const directoryExport = {
  tag: 'workspace', source: '/host/workspace', target: '/workspace', mode: 'rw',
} as const;
const overlay: ResolvedOverlay = {
  source: '/host/workspace/output',
  stagedDestination: `${rootPath}/output`,
  kind: 'directory',
};
const mask = { stagedDestination: `${rootPath}/hidden` };

function stats(kind: 'directory' | 'file' | 'symlink'): MountTreeStats {
  return {
    isDirectory: () => kind === 'directory',
    isFile: () => kind === 'file',
    isSymbolicLink: () => kind === 'symlink',
  };
}

function record(target: string, mode = 'ro', flags = 'nosuid,nodev', propagation = ''): string {
  return `31 29 0:42 / ${target} ${mode}${flags ? `,${flags}` : ''} ${propagation ? `${propagation} ` : ''}- ext4 /dev/root rw`;
}

function verifier(contents = record(rootPath)) {
  const dependencies = {
    realpath: jest.fn(async (value: string) => value),
    statPath: jest.fn(async () => stats('directory')),
    readMountInfo: jest.fn().mockResolvedValue(contents),
  };
  return { checks: new MountTreeVerifier({ rootPath, directoryExport, dependencies }), dependencies };
}

describe('mount-tree filesystem verification', () => {
  it('accepts canonical roots, contained overlays and directory masks', async () => {
    const { checks } = verifier();
    await expect(checks.assertRootIsCanonical()).resolves.toBeUndefined();
    await expect(checks.assertOverlaySource(overlay)).resolves.toBeUndefined();
    await expect(checks.assertOverlayDestination(overlay)).resolves.toBeUndefined();
    await expect(checks.assertMaskDestination(mask)).resolves.toBeUndefined();
  });

  it.each(['root', 'source', 'destination', 'mask'] as const)(
    'rejects redirected %s paths before inspecting their type',
    async (target) => {
      const { checks, dependencies } = verifier();
      dependencies.realpath.mockResolvedValue('/etc/unrelated');
      const check = target === 'root' ? checks.assertRootIsCanonical()
        : target === 'source' ? checks.assertOverlaySource(overlay)
          : target === 'destination' ? checks.assertOverlayDestination(overlay)
            : checks.assertMaskDestination(mask);
      await expect(check).rejects.toThrow('must be canonical');
      expect(dependencies.statPath).not.toHaveBeenCalled();
    },
  );

  it('rejects canonical targets outside the export or staged root', async () => {
    const { checks } = verifier();
    await expect(checks.assertOverlaySource({ ...overlay, source: '/host/workspace-other/output' }))
      .rejects.toThrow('must stay inside /host/workspace');
    await expect(checks.assertOverlayDestination({ ...overlay, stagedDestination: '/run/staged-other/output' }))
      .rejects.toThrow('must stay inside /run/staged');
    await expect(checks.assertMaskDestination({ stagedDestination: rootPath }))
      .rejects.toThrow('must stay inside /run/staged');
  });

  it.each(['source', 'destination', 'mask'] as const)('rejects symlink stats for %s', async (target) => {
    const { checks, dependencies } = verifier();
    dependencies.statPath.mockResolvedValue(stats('symlink'));
    await expect(target === 'source' ? checks.assertOverlaySource(overlay)
      : target === 'destination' ? checks.assertOverlayDestination(overlay)
        : checks.assertMaskDestination(mask)).rejects.toThrow('must not be a symbolic link');
  });

  it('requires the declared overlay kind and directory masks', async () => {
    const { checks, dependencies } = verifier();
    await expect(checks.assertOverlaySource({ ...overlay, kind: 'file' }))
      .rejects.toThrow('must be an existing regular file');
    await expect(checks.assertOverlayDestination({ ...overlay, kind: 'file' }))
      .rejects.toThrow('must be an existing regular file');
    dependencies.statPath.mockResolvedValue(stats('file'));
    await expect(checks.assertOverlaySource(overlay)).rejects.toThrow('must be an existing directory');
    await expect(checks.assertOverlayDestination(overlay)).rejects.toThrow('must be an existing directory');
    await expect(checks.assertMaskDestination(mask)).rejects.toThrow('must be an existing directory');
    await expect(checks.assertOverlaySource({ ...overlay, kind: 'file' })).resolves.toBeUndefined();
  });
});

describe('mount-tree mount verification', () => {
  it('requires the root mount and recursive read-only enforcement', async () => {
    await expect(verifier(record(`${rootPath}/child`)).checks.assertTreeIsReadonly())
      .rejects.toThrow('missing its root mount');
    await expect(verifier(`${record(rootPath)}\n${record(`${rootPath}/child`, 'rw')}`).checks.assertTreeIsReadonly())
      .rejects.toThrow('not recursively read-only');
    await expect(verifier().checks.assertTreeIsReadonly()).resolves.toBeUndefined();
  });

  it.each(['nosuid', 'nodev'])('rejects missing %s hardening', async (missing) => {
    const flags = missing === 'nosuid' ? 'nodev' : 'nosuid';
    await expect(verifier(record(rootPath, 'ro', flags)).checks.assertTreeIsReadonly())
      .rejects.toThrow(`missing ${missing}`);
  });

  it.each(['shared:1', 'master:2', 'propagate_from:3'])('rejects propagation %s', async (propagation) => {
    await expect(verifier(record(rootPath, 'ro', 'nosuid,nodev', propagation)).checks.assertTreeIsReadonly())
      .rejects.toThrow('propagation would leak');
  });

  it('requires a writable but hardened private root for masks-only plans', async () => {
    await expect(verifier('').checks.assertTreeIsHardenedAndPrivate()).rejects.toThrow('missing its root mount');
    await expect(verifier().checks.assertTreeIsHardenedAndPrivate()).rejects.toThrow('root is not writable');
    await expect(verifier(record(rootPath, 'rw')).checks.assertTreeIsHardenedAndPrivate()).resolves.toBeUndefined();
    await expect(verifier(record(rootPath, 'rw', 'nosuid')).checks.assertTreeIsHardenedAndPrivate())
      .rejects.toThrow('missing nodev');
    await expect(verifier(record(rootPath, 'rw', 'nosuid,nodev', 'shared:1')).checks.assertTreeIsHardenedAndPrivate())
      .rejects.toThrow('propagation would leak');
  });

  it('requires exactly the expected writable overlay destinations', async () => {
    await expect(verifier().checks.assertOnlyOverlaysAreWritable([overlay])).rejects.toThrow('was not applied');
    await expect(verifier(record(rootPath, 'rw')).checks.assertOnlyOverlaysAreWritable([overlay]))
      .rejects.toThrow('Unexpected writable mount');
    const contents = `${record(rootPath)}\n${record(overlay.stagedDestination, 'rw')}`;
    await expect(verifier(contents).checks.assertOnlyOverlaysAreWritable([overlay])).resolves.toBeUndefined();
    await expect(verifier(`${contents}\n${record(`${rootPath}/unexpected`, 'rw')}`).checks.assertOnlyOverlaysAreWritable([overlay]))
      .rejects.toThrow('Unexpected writable mount');
    await expect(verifier(record(overlay.stagedDestination, 'rw', 'nosuid,nodev', 'master:2'))
      .checks.assertOnlyOverlaysAreWritable([overlay])).rejects.toThrow('propagation would leak');
  });

  it('requires applied masks to be read-only, hardened and private', async () => {
    const { checks, dependencies } = verifier();
    await expect(checks.assertMasksAreHidden([])).resolves.toBeUndefined();
    expect(dependencies.readMountInfo).not.toHaveBeenCalled();
    await expect(checks.assertMasksAreHidden([mask])).rejects.toThrow('was not applied');
    await expect(verifier(record(mask.stagedDestination, 'rw')).checks.assertMasksAreHidden([mask]))
      .rejects.toThrow('Masked mount is not read-only');
    await expect(verifier(record(mask.stagedDestination, 'ro', 'nodev')).checks.assertMasksAreHidden([mask]))
      .rejects.toThrow('missing nosuid');
    await expect(verifier(record(mask.stagedDestination, 'ro', 'nosuid,nodev', 'propagate_from:3')).checks.assertMasksAreHidden([mask]))
      .rejects.toThrow('propagation would leak');
    await expect(verifier(record(mask.stagedDestination)).checks.assertMasksAreHidden([mask])).resolves.toBeUndefined();
  });

  it('reconciles remounts only when requested mode, hardening and privacy are satisfied', () => {
    const entry = { mountPoint: rootPath, options: ['rw', 'nosuid', 'nodev'], optionalFields: [] };
    expect(remountOptionsSatisfied(entry, 'remount,bind,rw,nosuid,nodev')).toBe(true);
    expect(remountOptionsSatisfied(entry, 'remount,bind,ro,nosuid,nodev')).toBe(false);
    expect(remountOptionsSatisfied(entry, 'remount,bind,nosuid,nodev')).toBe(true);
    expect(remountOptionsSatisfied({ ...entry, options: ['ro', 'nosuid', 'nodev'] }, 'remount,bind,nosuid,nodev')).toBe(true);
    expect(remountOptionsSatisfied({ ...entry, options: ['rw', 'nosuid'] }, 'remount,bind,rw')).toBe(false);
    for (const field of ['shared:1', 'master:2', 'propagate_from:3']) {
      expect(remountOptionsSatisfied({ ...entry, optionalFields: [field] }, 'remount,bind,rw')).toBe(false);
    }
  });

  it.each([
    ['mount from util-linux 2.23', true],
    ['mount from util-linux 3.0', true],
    ['mount from util-linux 2.22', false],
    ['mount from BusyBox', false],
  ])('checks the supported mount tool floor: %s', async (output, supported) => {
    const dependencies = { captureTool: jest.fn().mockResolvedValue(output) };
    const result = assertMountToolSupported({ mount: '/usr/bin/mount', umount: '/usr/bin/umount' }, dependencies);
    if (supported) await expect(result).resolves.toBeUndefined();
    else await expect(result).rejects.toThrow();
    expect(dependencies.captureTool).toHaveBeenCalledWith('/usr/bin/mount', ['--version']);
  });
});
