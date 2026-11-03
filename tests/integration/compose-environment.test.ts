import { describe, test, expect } from '@jest/globals';
import execa from 'execa';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { renderDockerCompose } from '../../src/compose-renderer';
import { DockerComposeConfig } from '../../src/types';
import { patchComposeWithTopologyHosts } from '../../src/topology';

describe('Compose literal environment values', () => {
  test('delivers the original bytes to containers, including after topology rewrites', async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'awf-compose-env-'));
    const composePath = path.join(workDir, 'docker-compose.yml');
    const project = path.basename(workDir).toLowerCase();
    const environment = {
      INVALID_EXPRESSION: '${warning.title}',
      BARE: '$NAME',
      BRACED: '${NAME}',
      DOUBLE: '$$',
      DEFAULT: '${NAME:-fallback}',
      MULTILINE: 'first $NAME\nsecond ${NAME}\n',
      QUOTES: '"double" \'single\'',
      BACKTICKS: '`printf unexpected`',
      COMMAND: '$(printf unexpected)',
      TRAILING_NEWLINES: '$NAME\n\n',
      EMPTY: '',
    };
    const compose: DockerComposeConfig = {
      services: Object.fromEntries(['agent', 'sidecar'].map(name => [name, {
        container_name: `${project}-${name}`,
        image: 'alpine:3.22',
        network_mode: 'none',
        environment,
      }])),
      networks: {},
    };
    const args = ['compose', '-p', project, '-f', composePath];

    try {
      await fs.writeFile(composePath, renderDockerCompose(compose));
      const log = { info: jest.fn(), warn: jest.fn() };
      patchComposeWithTopologyHosts(workDir, new Map([['peer', '192.0.2.1']]), log);
      patchComposeWithTopologyHosts(workDir, new Map([['peer', '192.0.2.1']]), log);
      await execa('docker', [...args, 'create'], {
        env: { NAME: 'host-value-must-not-replace-user-data' },
      });

      for (const name of Object.keys(compose.services)) {
        const { stdout } = await execa('docker', [
          'inspect', '--format', '{{json .Config.Env}}', `${project}-${name}`,
        ]);
        const actual = JSON.parse(stdout) as string[];
        for (const [key, value] of Object.entries(environment)) {
          expect(actual).toContain(`${key}=${value}`);
        }
      }
    } finally {
      await execa('docker', [...args, 'down'], { reject: false });
      await fs.rm(workDir, { recursive: true, force: true });
    }
  }, 120000);
});
