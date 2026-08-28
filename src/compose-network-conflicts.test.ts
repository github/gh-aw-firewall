import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import {
  composeNetworkConflictTestHelpers,
  removeConflictingComposeNetworks,
} from './compose-network-conflicts';
import { mockExecaFn } from './test-helpers/mock-execa.test-utils';
import { useTempDir } from './test-helpers/docker-test-fixtures.test-utils';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());

function writeCompose(workDir: string, networks: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(workDir, 'docker-compose.yml'),
    yaml.dump({ services: {}, networks })
  );
}

const { getFixedComposeNetworkNames, resolveComposeProjectName } = composeNetworkConflictTestHelpers;

describe('compose-network-conflicts', () => {
  const { getDir } = useTempDir();

  describe('resolveComposeProjectName', () => {
    it('derives the project name from the work directory basename', () => {
      expect(resolveComposeProjectName('/tmp/awf-1234567890')).toBe('awf-1234567890');
    });

    it('strips characters Compose does not allow', () => {
      expect(resolveComposeProjectName('/tmp/AWF.Test_1')).toBe('awftest_1');
    });

    it('prefers COMPOSE_PROJECT_NAME when set', () => {
      const previous = process.env.COMPOSE_PROJECT_NAME;
      process.env.COMPOSE_PROJECT_NAME = 'custom-project';
      try {
        expect(resolveComposeProjectName('/tmp/awf-1')).toBe('custom-project');
      } finally {
        if (previous === undefined) {
          delete process.env.COMPOSE_PROJECT_NAME;
        } else {
          process.env.COMPOSE_PROJECT_NAME = previous;
        }
      }
    });
  });

  describe('getFixedComposeNetworkNames', () => {
    it('returns an empty list when no compose file exists', () => {
      expect(getFixedComposeNetworkNames(getDir())).toEqual([]);
    });

    it('returns only pinned, non-external network names', () => {
      writeCompose(getDir(), {
        'awf-net': { name: 'awf-net', internal: true },
        'awf-ext': { driver: 'bridge' },
        'awf-external': { external: true, name: 'awf-preexisting' },
      });

      expect(getFixedComposeNetworkNames(getDir())).toEqual(['awf-net']);
    });

    it('ignores external networks entirely (host-iptables mode)', () => {
      writeCompose(getDir(), { 'awf-net': { external: true } });

      expect(getFixedComposeNetworkNames(getDir())).toEqual([]);
    });
  });

  describe('removeConflictingComposeNetworks', () => {
    it('does nothing when the compose file declares no pinned networks', async () => {
      writeCompose(getDir(), { 'awf-net': { external: true } });

      await removeConflictingComposeNetworks(getDir());

      expect(mockExecaFn).not.toHaveBeenCalled();
    });

    it('does nothing when the network does not exist', async () => {
      writeCompose(getDir(), { 'awf-net': { name: 'awf-net' } });
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 } as any);

      await removeConflictingComposeNetworks(getDir());

      expect(mockExecaFn).toHaveBeenCalledTimes(1);
      expect(mockExecaFn).not.toHaveBeenCalledWith(
        'docker',
        ['network', 'rm', 'awf-net'],
        expect.anything()
      );
    });

    it('keeps a network already owned by the current compose project', async () => {
      writeCompose(getDir(), { 'awf-net': { name: 'awf-net' } });
      mockExecaFn.mockResolvedValueOnce({
        stdout: resolveComposeProjectName(getDir()),
        stderr: '',
        exitCode: 0,
      } as any);

      await removeConflictingComposeNetworks(getDir());

      expect(mockExecaFn).toHaveBeenCalledTimes(1);
    });

    it('removes an orphaned network owned by another project', async () => {
      writeCompose(getDir(), { 'awf-net': { name: 'awf-net' } });
      // inspect labels -> stale project
      mockExecaFn.mockResolvedValueOnce({ stdout: 'awf-1111111111', stderr: '', exitCode: 0 } as any);
      // network rm succeeds
      mockExecaFn.mockResolvedValueOnce({ stdout: 'awf-net', stderr: '', exitCode: 0 } as any);

      await removeConflictingComposeNetworks(getDir());

      expect(mockExecaFn).toHaveBeenCalledWith(
        'docker',
        ['network', 'rm', 'awf-net'],
        expect.objectContaining({ reject: false })
      );
    });

    it('removes an unlabelled leftover network', async () => {
      writeCompose(getDir(), { 'awf-net': { name: 'awf-net' } });
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      mockExecaFn.mockResolvedValueOnce({ stdout: 'awf-net', stderr: '', exitCode: 0 } as any);

      await removeConflictingComposeNetworks(getDir());

      expect(mockExecaFn).toHaveBeenCalledWith(
        'docker',
        ['network', 'rm', 'awf-net'],
        expect.objectContaining({ reject: false })
      );
    });

    it('detaches lingering endpoints and retries when removal fails', async () => {
      writeCompose(getDir(), { 'awf-net': { name: 'awf-net' } });
      // inspect labels -> stale project
      mockExecaFn.mockResolvedValueOnce({ stdout: 'awf-1111111111', stderr: '', exitCode: 0 } as any);
      // first rm fails (active endpoints)
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: 'has active endpoints', exitCode: 1 } as any);
      // inspect containers
      mockExecaFn.mockResolvedValueOnce({
        stdout: JSON.stringify({ abc123: { Name: 'awf-agent' } }),
        stderr: '',
        exitCode: 0,
      } as any);
      // inspect the endpoint: stale container from the same Compose project
      mockExecaFn.mockResolvedValueOnce({
        stdout: '{"com.docker.compose.project":"awf-1111111111"}\texited',
        stderr: '',
        exitCode: 0,
      } as any);
      // disconnect
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      // second rm succeeds
      mockExecaFn.mockResolvedValueOnce({ stdout: 'awf-net', stderr: '', exitCode: 0 } as any);

      await removeConflictingComposeNetworks(getDir());

      expect(mockExecaFn).toHaveBeenCalledWith(
        'docker',
        ['network', 'disconnect', '-f', 'awf-net', 'abc123'],
        expect.objectContaining({ reject: false })
      );
      expect(mockExecaFn).toHaveBeenCalledTimes(6);
    });

    it('leaves running containers from other tools attached', async () => {
      writeCompose(getDir(), { 'awf-net': { name: 'awf-net' } });
      mockExecaFn.mockResolvedValueOnce({ stdout: 'awf-1111111111', stderr: '', exitCode: 0 } as any);
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: 'has active endpoints', exitCode: 1 } as any);
      mockExecaFn.mockResolvedValueOnce({
        stdout: JSON.stringify({ external123: { Name: 'other-tool' } }),
        stderr: '',
        exitCode: 0,
      } as any);
      mockExecaFn.mockResolvedValueOnce({
        stdout: '{"com.docker.compose.project":"other-project"}\trunning',
        stderr: '',
        exitCode: 0,
      } as any);
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: 'has active endpoints', exitCode: 1 } as any);

      await removeConflictingComposeNetworks(getDir());

      expect(mockExecaFn).not.toHaveBeenCalledWith(
        'docker',
        ['network', 'disconnect', '-f', 'awf-net', 'external123'],
        expect.anything()
      );
    });

    it('does not throw when the network cannot be removed', async () => {
      writeCompose(getDir(), { 'awf-net': { name: 'awf-net' } });
      mockExecaFn.mockResolvedValueOnce({ stdout: 'awf-1111111111', stderr: '', exitCode: 0 } as any);
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: 'permission denied', exitCode: 1 } as any);
      mockExecaFn.mockResolvedValueOnce({ stdout: 'null', stderr: '', exitCode: 0 } as any);
      mockExecaFn.mockResolvedValueOnce({ stdout: '', stderr: 'permission denied', exitCode: 1 } as any);

      await expect(removeConflictingComposeNetworks(getDir())).resolves.toBeUndefined();
    });

    it('tolerates inspect errors', async () => {
      writeCompose(getDir(), { 'awf-net': { name: 'awf-net' } });
      mockExecaFn.mockRejectedValueOnce(new Error('docker daemon unreachable'));

      await expect(removeConflictingComposeNetworks(getDir())).resolves.toBeUndefined();
    });
  });
});
