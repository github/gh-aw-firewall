import {
  localAwfImageDownloadRegex,
  standaloneSkipPullRegex,
} from './workflow-patch-patterns';

describe('standaloneSkipPullRegex', () => {
  it.each([
    ['awf --skip-pull -- command', 'awf --build-local -- command'],
    ['awf --skip-pull --build-local -- command', 'awf --build-local -- command'],
  ])('normalizes local-build flags in %s', (input, expected) => {
    expect(input.replace(standaloneSkipPullRegex, '--build-local')).toBe(expected);
  });

  describe('localAwfImageDownloadRegex', () => {
    it('removes only locally built AWF images from the generated download command', () => {
      const command =
        'download_docker_images.sh ghcr.io/github/gh-aw-firewall/agent:0.28.0@sha256:' +
        'a'.repeat(64) +
        ' ghcr.io/github/gh-aw-firewall/api-proxy:0.28.0@sha256:' +
        'b'.repeat(64) +
        ' ghcr.io/github/gh-aw-firewall/squid:0.28.0@sha256:' +
        'c'.repeat(64) +
        ' ' +
        'ghcr.io/github/gh-aw-node@sha256:abc';

      expect(command.replace(localAwfImageDownloadRegex, '')).toBe(
        'download_docker_images.sh ghcr.io/github/gh-aw-node@sha256:abc',
      );
    });
  });
});
