import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const repositoryRoot = path.resolve(__dirname, '../..');
const containerDirectories = [
  'agent',
  'api-proxy',
  'build-tools',
  'cli-proxy',
  'dind-ubuntu',
  'enclave',
  'gh-aw-node',
  'squid',
];
const dockerfiles = [
  ...containerDirectories.map((directory) =>
    path.join(repositoryRoot, 'containers', directory, 'Dockerfile'),
  ),
  path.join(repositoryRoot, 'containers/agent/Dockerfile.minimal'),
];

describe('container base image pins', () => {
  it('pins every concrete FROM image to an immutable manifest digest', () => {
    for (const dockerfile of dockerfiles) {
      const source = fs.readFileSync(dockerfile, 'utf-8');
      const fromLines = source
        .split(/\r?\n/)
        .filter((line) => /^\s*FROM\s+/i.test(line));

      expect(fromLines.length).toBeGreaterThan(0);
      for (const line of fromLines) {
        const match = line.match(/^\s*FROM\s+(?:(?:--platform=\S+)\s+)?(\S+)/i);
        expect(match).not.toBeNull();
        const image = match![1];
        if (image.startsWith('$')) {
          expect(image).toBe('${BASE_IMAGE}');
          continue;
        }
        expect(image).toMatch(/@sha256:[a-f0-9]{64}$/);
      }

      if (source.includes('FROM ${BASE_IMAGE}')) {
        expect(source).toMatch(
          /^ARG BASE_IMAGE=ubuntu:22\.04@sha256:[a-f0-9]{64}$/m,
        );
      }
    }
  });

  it('keeps Dependabot Docker digest updates enabled for all covered containers', () => {
    const config = yaml.load(
      fs.readFileSync(path.join(repositoryRoot, '.github/dependabot.yml'), 'utf-8'),
    ) as { updates: Array<{ directory: string; 'package-ecosystem': string }> };

    for (const directory of containerDirectories) {
      expect(
        config.updates.some(
          (update) =>
            update.directory === `/containers/${directory}` &&
            update['package-ecosystem'] === 'docker',
        ),
      ).toBe(true);
    }
  });
});
