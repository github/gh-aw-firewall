import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const targets = [
  { image: 'agent', stage: 'one-shot-token-build', index: 0 },
  { image: 'agent', stage: 'main', index: 1 },
];

const legacySources = [
  'deb http://archive.ubuntu.com/ubuntu resolute main universe',
  'deb http://security.ubuntu.com/ubuntu resolute-security main universe',
  'deb https://download.docker.com/linux/ubuntu resolute stable',
  '',
].join('\n');

const deb822Sources = [
  'Types: deb',
  'URIs: http://archive.ubuntu.com/ubuntu/',
  'Suites: resolute resolute-updates resolute-backports',
  'Components: main universe',
  'Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg',
  '',
  'Types: deb',
  'URIs: http://security.ubuntu.com/ubuntu/',
  'Suites: resolute-security',
  'Components: main universe',
  'Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg',
  '',
].join('\n');

const thirdPartySources = 'Types: deb\nURIs: https://example.com/packages\nSuites: stable\n';

describe.each(targets)('$image Dockerfile ($stage) apt mirrors', ({ image, index }) => {
  const dockerfile = fs.readFileSync(
    path.resolve(__dirname, `../../containers/${image}/Dockerfile`), 'utf8',
  );
  const selectionBlocks = dockerfile.match(
    /if getent hosts azure\.archive\.ubuntu\.com[\s\S]*?^    fi/gm,
  ) ?? [];
  const fallbackBlocks = dockerfile.match(
    /force_archive_mirror\(\) \{[\s\S]*?^    \};/gm,
  ) ?? [];

  it('covers every mirror selection and fallback block', () => {
    const expected = targets.filter(target => target.image === image).length;
    expect(selectionBlocks).toHaveLength(expected);
    expect(fallbackBlocks).toHaveLength(expected);
  });

  describe.each(['legacy', 'deb822', 'mixed', 'missing'])('%s sources', layout => {
    let directory: string;
    let originals: Map<string, string>;

    beforeEach(() => {
      directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-apt-mirror-'));
      originals = new Map();
      if (layout === 'legacy' || layout === 'mixed') {
        originals.set('sources.list', legacySources);
      }
      if (layout === 'deb822' || layout === 'mixed') {
        originals.set('sources.list.d/ubuntu.sources', deb822Sources);
        originals.set('sources.list.d/third-party.sources', thirdPartySources);
      }
      for (const [file, contents] of originals) {
        const destination = path.join(directory, 'apt', file);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, contents);
      }
    });

    afterEach(() => {
      fs.rmSync(directory, { recursive: true, force: true });
    });

    const run = (script: string, dnsStatus = 0, updateStatus = 0) => {
      let shell = script
        .replace(/\\\r?\n/g, ' ')
        .replace(/\/etc\/apt/g, '"$FIXTURE_APT"')
        .replace(/\/var\/lib\/apt\/lists/g, '"$FIXTURE_APT/lists"');
      // Docker uses GNU sed; adapt only its in-place flag for local macOS runs.
      if (process.platform === 'darwin') {
        shell = shell.replace(/sed -i /g, "sed -i '' ");
      }
      return spawnSync('bash', ['-eu', '-c', `
getent() { return "$DNS_STATUS"; }
rm() { printf 'rm %s\\n' "$*"; }
apt-get() { printf 'apt-get %s\\n' "$*"; return "$UPDATE_STATUS"; }
${shell}
`], {
        encoding: 'utf8',
        timeout: 5000,
        env: {
          PATH: process.env.PATH,
          FIXTURE_APT: path.join(directory, 'apt'),
          DNS_STATUS: String(dnsStatus),
          UPDATE_STATUS: String(updateStatus),
        },
      });
    };

    const expectSources = (mirror?: 'azure' | 'archive') => {
      for (const [file, original] of originals) {
        const expected = mirror
          ? original.replace(
            /http:\/\/(?:archive|security)\.ubuntu\.com/g,
            `http://${mirror === 'azure' ? 'azure.archive' : 'archive'}.ubuntu.com`,
          )
          : original;
        expect(fs.readFileSync(path.join(directory, 'apt', file), 'utf8')).toBe(expected);
      }
    };

    it('selects Azure for archive and security sources when DNS resolves', () => {
      const result = run(selectionBlocks[index]);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expectSources('azure');
    });

    it('leaves sources unchanged when Azure DNS fails', () => {
      const result = run(selectionBlocks[index], 1);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expectSources();
    });

    it('falls back from Azure to archive and refreshes package indexes', () => {
      const selected = run(selectionBlocks[index]);
      expect(selected.status).toBe(0);
      expectSources('azure');
      const result = run(`${fallbackBlocks[index]}\nforce_archive_mirror`);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('Falling back to archive.ubuntu.com mirror');
      expect(result.stdout).toContain(`rm -rf ${path.join(directory, 'apt/lists')}/*`);
      expect(result.stdout).toMatch(/apt-get .*update/);
      expectSources('archive');
    });

    it('normalizes default security sources during fallback', () => {
      const result = run(`${fallbackBlocks[index]}\nforce_archive_mirror`);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expectSources('archive');
    });

    it('propagates apt update failures after switching back to archive', () => {
      const selected = run(selectionBlocks[index]);
      expect(selected.status).toBe(0);
      const result = run(`${fallbackBlocks[index]}\nforce_archive_mirror`, 0, 100);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(100);
      expectSources('archive');
    });
  });
});

describe('build-tools standard Ubuntu mirrors', () => {
  const dockerfile = fs.readFileSync(
    path.resolve(__dirname, '../../containers/build-tools/Dockerfile'), 'utf8',
  );
  const installBlock = dockerfile.match(/^RUN set -eux;[\s\S]*?(?=\n\nCOPY)/m)![0]
    .replace(/^RUN /, '')
    .split('\n')
    .filter(line => !line.trim().startsWith('#'))
    .join('\n')
    .replace(/\\\r?\n/g, ' ');

  it('does not replace archive/security sources based on Azure DNS reachability', () => {
    expect(dockerfile).not.toContain('azure.archive.ubuntu.com');
    expect(dockerfile).not.toContain('getent hosts');
    expect(dockerfile).not.toMatch(/sed .*sources|force_archive_mirror/);
  });

  it.each(['success', 'update', 'install', 'upgrade'])(
    'keeps required packages, security upgrades, and hard failure on %s',
    failure => {
      const result = spawnSync('bash', ['-eu', '-c', `
apt-get() {
  printf 'apt-get %s\\n' "$*"
  case " $* " in
    *" $FAILURE "*) return 100 ;;
  esac
}
rm() { printf 'rm %s\\n' "$*"; }
${installBlock}
`], {
        encoding: 'utf8',
        timeout: 5000,
        env: { PATH: process.env.PATH, FAILURE: failure },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(failure === 'success' ? 0 : 100);
      expect(result.stdout).toContain('APT::Update::Error-Mode=any update');
      expect(result.stdout).toContain('Acquire::Retries=3');
      if (failure === 'update') {
        expect(result.stdout).not.toContain(' install ');
      } else {
        expect(result.stdout).toContain('install -y --no-install-recommends');
        expect(result.stdout).toContain('build-essential gcc g++ make cmake');
        expect(result.stdout).toContain('ca-certificates curl wget git jq');
        expect(result.stdout).toContain('libcap2-bin gosu gnupg');
      }
      if (failure === 'success') {
        expect(result.stdout).toContain('upgrade -y');
        expect(result.stdout).toContain('rm -f /usr/bin/pebble');
      } else {
        expect(result.stdout).not.toContain('rm -f /usr/bin/pebble');
      }
    },
  );
});
