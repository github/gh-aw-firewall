import { execFileSync, spawnSync } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildMicrovmScratchInit } from './scratch-init';

describe('microVM scratch init', () => {
  it.each([0, -1, 1.5, Infinity, 4294967296])('rejects invalid sizing %s', (size) => {
    expect(() => buildMicrovmScratchInit(size, '/usr/sbin/awf-supervisor')).toThrow(/scratch MiB/);
  });

  it('rejects unsafe supervisor paths', () => {
    expect(() => buildMicrovmScratchInit(96, "/usr/sbin/awf';echo unsafe")).toThrow(/Unsafe/);
  });

  it.each([96, 2048, 4294967295])('is valid POSIX shell and uses a byte-exact, executable sticky tmpfs (%s MiB)', (scratchMib) => {
    const script = buildMicrovmScratchInit(scratchMib, '/usr/sbin/awf-supervisor');
    expect(script).toContain(`size=${scratchMib * 1024 * 1024},mode=1777,nosuid,nodev`);
    expect(script).not.toContain('noexec');
    expect(script).toContain("exec '/usr/sbin/awf-supervisor'");
    execFileSync('/bin/sh', ['-n'], { input: script });
  });

  it.each<[number, string, string, boolean]>([
    [96, '1021994 24576 4096', '0', true],
    [96, 'ef53 24576 4096', '0', false],
    [96, '1021994 24575 4096', '0', false],
    [96, '1021994 24577 4096', '0', false],
    [96, '', '0', false],
    [96, '1021994 24576 4096', '1', false],
    [2048, '1021994 524288 4096', '0', true],
  ])('executes the pinned supervisor only after verified scratch setup (%s MiB, %s, mount failure=%s)',
    async (scratchMib, statfs, failMount, succeeds) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awf-scratch-init-'));
      try {
        const log = path.join(root, 'calls');
        const supervisor = path.join(root, 'pinned-supervisor');
        const commands = {
          mkdir: '#!/bin/sh\nprintf "mkdir:%s\\n" "$*" >> "$AWF_TEST_CALLS"\n',
          mount: '#!/bin/sh\nprintf "mount:%s\\n" "$*" >> "$AWF_TEST_CALLS"\ncase "$*" in *"-t tmpfs"*) exit "$AWF_TEST_FAIL_MOUNT";; esac\n',
          stat: '#!/bin/sh\nprintf "stat:%s\\n" "$*" >> "$AWF_TEST_CALLS"\nprintf "%s\\n" "$AWF_TEST_STATFS"\n',
          'pinned-supervisor': '#!/bin/sh\nprintf "supervisor\\n" >> "$AWF_TEST_CALLS"\n',
        };
        for (const [name, contents] of Object.entries(commands)) {
          await fs.writeFile(path.join(root, name), contents, { mode: 0o755 });
        }
        const script = buildMicrovmScratchInit(scratchMib, supervisor)
          .replace('PATH=/usr/sbin:/usr/bin:/sbin:/bin', `PATH='${root}'`);
        const result = spawnSync('/bin/sh', [], {
          input: script,
          env: {
            AWF_TEST_CALLS: log,
            AWF_TEST_STATFS: statfs,
            AWF_TEST_FAIL_MOUNT: failMount,
          },
        });
        const calls = await fs.readFile(log, 'utf8');
        expect(result.status === 0).toBe(succeeds);
        expect(calls.includes('supervisor\n')).toBe(succeeds);
        expect(calls).toContain(`mount:-n -t tmpfs -o size=${scratchMib * 1024 * 1024},mode=1777,nosuid,nodev awf-scratch /tmp`);
        if (succeeds) {
          expect(calls.indexOf('stat:')).toBeLessThan(calls.indexOf('supervisor\n'));
        }
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
});
