import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cleanupArtifactSnapshot } from './runtime-cleanup';

describe('Cloud Hypervisor runtime cleanup completion', () => {
  it('removes the trusted snapshot before completing every cleaned manager record', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ch-cleanup-completion-'));
    const snapshot = path.join(root, 'trusted-artifact-snapshot');
    const primaryRecord = path.join(root, 'primary-cleanup-record');
    const peerRecord = path.join(root, 'peer-cleanup-record');
    await Promise.all([
      fs.mkdir(snapshot),
      fs.writeFile(primaryRecord, 'primary'),
      fs.writeFile(peerRecord, 'peer'),
    ]);
    const completionOrder: string[] = [];
    const manager = (name: string, record: string) => ({
      paths: { runDirectory: path.join(root, name) },
      execute: jest.fn(),
      cancel: jest.fn(),
      stop: jest.fn(),
      collectDiagnostics: jest.fn(),
      completeCleanupRecord: jest.fn(async () => {
        await expect(fs.stat(snapshot)).rejects.toMatchObject({ code: 'ENOENT' });
        await fs.unlink(record);
        completionOrder.push(name);
      }),
    });
    const primary = manager('primary', primaryRecord);
    const peer = manager('peer', peerRecord);
    const cleanedManagers = new Set([primary, peer]);

    try {
      await expect(cleanupArtifactSnapshot({
        preflightResult: { artifactSnapshotDirectory: snapshot },
        manager: primary,
        cleanedManagers,
        removeArtifactSnapshot: (directory) => fs.rm(directory, { recursive: true }),
      })).resolves.toBe(true);

      await expect(fs.stat(snapshot)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.stat(primaryRecord)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.stat(peerRecord)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(completionOrder).toEqual(['primary', 'peer']);
      expect(cleanedManagers.size).toBe(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('retains cleanup records when trusted snapshot removal fails', async () => {
    const completeCleanupRecord = jest.fn();
    const manager = {
      paths: { runDirectory: '/run/primary' },
      execute: jest.fn(),
      cancel: jest.fn(),
      stop: jest.fn(),
      collectDiagnostics: jest.fn(),
      completeCleanupRecord,
    };
    const cleanedManagers = new Set([manager]);

    await expect(cleanupArtifactSnapshot({
      preflightResult: { artifactSnapshotDirectory: '/trusted/snapshot' },
      manager,
      cleanedManagers,
      removeArtifactSnapshot: async () => {
        throw new Error('snapshot removal failed');
      },
    })).rejects.toThrow(/snapshot removal failed/);

    expect(completeCleanupRecord).not.toHaveBeenCalled();
    expect(cleanedManagers).toEqual(new Set([manager]));
  });
});
