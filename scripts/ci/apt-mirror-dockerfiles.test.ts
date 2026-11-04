import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

const read = (image: string) => fs.readFileSync(
  path.resolve(__dirname, `../../containers/${image}/Dockerfile`), 'utf8',
);
const instructions = (source: string) => source
  .replace(/^[ \t]*#.*\r?\n/gm, '')
  .replace(/\\\r?\n/g, ' ')
  .split('\n');

describe.each(['build-tools', 'agent'])('%s standard Ubuntu mirrors', image => {
  const dockerfile = read(image);

  it('retains the base image archive/security sources instead of DNS-only Azure selection', () => {
    expect(dockerfile).not.toContain('azure.archive.ubuntu.com');
    expect(dockerfile).not.toContain('getent hosts');
    expect(dockerfile).not.toMatch(/sed .*sources|force_archive_mirror/);
  });

  it('retries fetches and rejects incomplete package indexes in every Ubuntu stage', () => {
    const updates = dockerfile.match(/apt-get [^;]*?\bupdate/g) ?? [];
    expect(updates).toHaveLength(image === 'agent' ? 3 : 1);
    for (const command of updates) {
      expect(command).toContain('Acquire::Retries=3');
      expect(command).toContain('APT::Update::Error-Mode=any');
    }
  });
});

const agentInstructions = instructions(read('agent'));
const cases = [
  {
    stage: 'build-tools',
    instruction: instructions(read('build-tools')).find(line => line.includes('libcap2-bin gosu gnupg'))!,
    stop: 'rm -f /usr/bin/pebble',
    packages: ['build-essential gcc g++ make cmake', 'ca-certificates curl wget git jq', 'libcap2-bin gosu gnupg'],
    upgrade: true,
  },
  {
    stage: 'agent token compiler',
    instruction: agentInstructions.find(line => line.includes('gcc -shared'))!,
    stop: 'gcc -shared',
    packages: ['gcc libc6-dev binutils'],
    upgrade: false,
  },
  {
    stage: 'agent browser libraries',
    instruction: agentInstructions.find(line => line.startsWith('RUN ') && line.includes('BROWSER_PKGS="'))!,
    stop: 'apt-cache depends',
    packages: ['libasound2', 'libudev1', 'fonts-liberation'],
    upgrade: true,
  },
  {
    stage: 'agent runtime',
    instruction: agentInstructions.find(line => line.includes('NPM_TGZ_URL='))!,
    stop: 'rm -f /usr/bin/pebble',
    packages: ['iptables curl ca-certificates git gnupg', 'libcap2-bin libgdiplus libev-dev libssl-dev php-intl php-gd python3'],
    upgrade: true,
  },
];

describe.each(cases)('$stage apt failure handling', ({ instruction, stop, packages, upgrade }) => {
  it.each(['success', 'update', 'install', ...(upgrade ? ['upgrade'] : [])])(
    'preserves required packages and stops on %s failure',
    failure => {
      expect(instruction).toBeDefined();
      expect(instruction.indexOf(stop)).toBeGreaterThan(0);
      const script = instruction.slice('RUN '.length, instruction.indexOf(stop));
      const result = spawnSync('bash', ['-eu', '-c', `
apt-get() {
  printf 'apt-get %s\\n' "$*"
  case " $* " in
    *" $FAILURE "*) return 100 ;;
  esac
}
cat() { printf 'libasound2 libudev1\\n'; }
apt-cache() { return 100; }
${script} printf 'apt-complete\\n'
`], {
        encoding: 'utf8',
        timeout: 5000,
        env: { PATH: process.env.PATH, FAILURE: failure },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(failure === 'success' ? 0 : 100);
      expect(result.stdout).toContain('APT::Update::Error-Mode=any update');
      expect(result.stdout.includes('apt-complete')).toBe(failure === 'success');
      if (failure === 'success') {
        expect(result.stdout).toContain('install -y --no-install-recommends');
        for (const required of packages) expect(result.stdout).toContain(required);
        expect(result.stdout.includes('upgrade -y')).toBe(upgrade);
      }
    },
  );
});
