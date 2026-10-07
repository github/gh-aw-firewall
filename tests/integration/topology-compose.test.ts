import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import execa from 'execa';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createRunner } from '../fixtures/awf-runner';
import { cleanup } from '../fixtures/cleanup';

describe('Compose topology attachment', () => {
  let workDir: string;
  let composePath: string;

  beforeAll(async () => {
    await cleanup(false);
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'awf-compose-test-'));
    composePath = path.join(workDir, 'compose.yml');
    await fs.writeFile(composePath, `
services:
  web:
    image: nginx:stable-alpine
    container_name: awf-compose-web
  backend:
    image: nginx:stable-alpine
`);
    await execa('docker', ['compose', '-p', 'awf-compose-test', '-f', composePath, 'up', '-d', '--wait']);
  }, 120000);

  afterAll(async () => {
    // Remove the attached peer before AWF tries to remove its network.
    if (composePath) {
      await execa('docker', ['compose', '-p', 'awf-compose-test', '-f', composePath, 'down'], { reject: false });
    }
    await cleanup(false);
    if (workDir) await fs.rm(workDir, { recursive: true, force: true });
  });

  test('reaches a dual-homed frontend directly and through Squid without attaching its backend', async () => {
    const configPath = path.join(workDir, 'awf.json');
    await fs.writeFile(configPath, JSON.stringify({
      network: {
        isolation: true,
        topologyAttach: ['awf-compose-web'],
        allowDomains: ['awf-compose-web'],
      },
    }));

    const result = await createRunner().run(
      'getent hosts awf-compose-web && ' +
      'curl --fail --retry 10 --retry-connrefused --retry-delay 1 http://awf-compose-web/ && ' +
      'curl --fail --noproxy "" --proxy "$HTTP_PROXY" http://awf-compose-web/ && ' +
      'test "$(curl --silent --noproxy "" --proxy "$HTTP_PROXY" -o /dev/null -w "%{http_code}" http://example.org/)" = 403',
      { configFile: configPath, keepContainers: true, timeout: 120000 },
    );

    const { stdout: networks } = await execa('docker', [
      'inspect', '--format', '{{json .NetworkSettings.Networks}}', 'awf-compose-web',
    ]);
    expect(Object.keys(JSON.parse(networks))).toEqual(
      expect.arrayContaining(['awf-compose-test_default', 'awf-net']),
    );

    const { stdout: backend } = await execa('docker', [
      'exec', 'awf-compose-web', 'wget', '-qO-', 'http://backend/',
    ]);
    expect(backend).toContain('Welcome to nginx!');

    const { stdout: backendId } = await execa('docker', [
      'compose', '-p', 'awf-compose-test', '-f', composePath, 'ps', '-q', 'backend',
    ]);
    const { stdout: backendNetworks } = await execa('docker', [
      'inspect', '--format', '{{json .NetworkSettings.Networks}}', backendId.trim(),
    ]);
    expect(Object.keys(JSON.parse(backendNetworks))).toEqual(['awf-compose-test_default']);

    expect(result).toMatchObject({ success: true, exitCode: 0 });
    expect(result.stdout).toContain('Welcome to nginx!');
  }, 180000);
});
