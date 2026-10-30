import execa from 'execa';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildCredentialHidingOverlays,
  pruneUnmountableCredentialOverlays,
} from '../../src/services/agent-volumes/credential-hiding';

describe('GitLab credential bind overlays', () => {
  test('hides seeded GitLab credentials and the GitHub control without hiding benign config', async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-glab-'));
    const home = path.join(fixture, 'home');
    const credentialPaths = [
      '.config/glab-cli/config.yml',
      '.config/gh/hosts.yml',
      '.config/custom-glab/config.yml',
      '.config/xdg/glab-cli/config.yml',
      'Library/Application Support/glab-cli/config.yml',
    ];
    const canary = 'AWF_GITLAB_TEST_CANARY_NOT_A_REAL_SECRET';
    const benign = path.join(home, '.config/glab-cli/aliases.yml');
    try {
      for (const relative of credentialPaths) {
        const file = path.join(home, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, canary, { mode: 0o600 });
      }
      fs.writeFileSync(benign, 'benign-alias');
      const volumes = [
        `${home}/.config:${home}/.config:ro`,
        `${home}/.config:/host${home}/.config:ro`,
        `${home}/Library:/host${home}/Library:ro`,
        `${home}/.config/custom-glab:/gitlab-alias:ro`,
      ];
      volumes.push(...buildCredentialHidingOverlays(home, volumes, undefined, {
        GLAB_CONFIG_DIR: `${home}/.config/custom-glab`,
        XDG_CONFIG_HOME: `${home}/.config/xdg`,
      }));
      const args = ['run', '--rm', '--network', 'none', '--cap-drop', 'ALL'];
      for (const volume of pruneUnmountableCredentialOverlays(volumes)) {
        args.push('--volume', volume);
      }
      args.push('debian:bookworm-slim', 'sh', '-ec', `
        for file do
          test -e "$file"
          test "$(wc -c < "$file")" -eq 0
        done
        test "$(cat '${benign}')" = benign-alias
        test "$(cat '/host${benign}')" = benign-alias
        printf 'credential-masks-confirmed\\n'
      `, 'sh',
      ...credentialPaths.map((relative) => `/host${home}/${relative}`),
      ...credentialPaths.filter((relative) => relative.startsWith('.config/'))
        .map((relative) => `${home}/${relative}`),
      '/gitlab-alias/config.yml');

      const result = await execa('docker', args, { timeout: 60000 });
      expect(result.stdout.trim()).toBe('credential-masks-confirmed');
      for (const relative of credentialPaths) {
        expect(fs.readFileSync(path.join(home, relative), 'utf8')).toBe(canary);
      }
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  }, 90000);
});
