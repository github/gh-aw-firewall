import { WorkflowCommandFilter } from './workflow-command-filter';

function filter(chunks: readonly Buffer[]): Buffer {
  const subject = new WorkflowCommandFilter();
  return Buffer.concat([...chunks.map((chunk) => subject.push(chunk)), subject.finish()]);
}

describe('WorkflowCommandFilter', () => {
  it('preserves ordinary and non-UTF-8 output byte-for-byte', () => {
    const input = Buffer.from([
      ...Buffer.from('plain :: text\n:not-a-command\n::1-not-a-command\r\n'),
      0xff,
      0xfe,
      0x00,
      0x3a,
    ]);

    expect(filter([input])).toEqual(input);
  });

  it('neutralizes workflow command syntax after leading whitespace on LF and CRLF lines', () => {
    const input = Buffer.from(
      '::set-output name=result::owned\n' +
      '\t ::stop-commands::token\r\n' +
      '  ::error file=x::untrusted annotation\r' +
      'safe::set-env::mid-line\n',
    );

    expect(filter([input]).toString()).toBe(
      '[awf blocked workflow command] : :set-output name=result::owned\n' +
      '\t [awf blocked workflow command] : :stop-commands::token\r\n' +
      '  [awf blocked workflow command] : :error file=x::untrusted annotation\r' +
      'safe::set-env::mid-line\n',
    );
  });

  it('recognizes command starts split at every relevant chunk boundary', () => {
    const chunks = [
      Buffer.from(' \t:'),
      Buffer.from(':'),
      Buffer.from('s'),
      Buffer.from('et-env::owned\r'),
      Buffer.from('\n:'),
      Buffer.from(':add-mask::secret'),
    ];

    expect(filter(chunks).toString()).toBe(
      ' \t[awf blocked workflow command] : :set-env::owned\r\n' +
      '[awf blocked workflow command] : :add-mask::secret',
    );
  });

  it('matches the runner whitespace trim across split UTF-8 sequences', () => {
    const whitespace = [
      '\u0085',
      '\u00a0',
      '\u1680',
      '\u2000',
      '\u200a',
      '\u2028',
      '\u2029',
      '\u202f',
      '\u205f',
      '\u3000',
    ].join('');
    const input = Buffer.from(`${whitespace}::stop-commands::token\n`);
    const chunks = Array.from(input, (byte) => Buffer.from([byte]));

    expect(filter(chunks).toString()).toBe(
      `${whitespace}[awf blocked workflow command] : :stop-commands::token\n`,
    );
  });

  it('preserves invalid UTF-8 whitespace candidates byte-for-byte', () => {
    const input = Buffer.from([0xe2, 0x0a, 0x3a, 0x3a, 0x31, 0xff]);
    expect(filter(Array.from(input, (byte) => Buffer.from([byte])))).toEqual(input);
  });

  it('flushes incomplete candidates without changing them', () => {
    expect(filter([Buffer.from('one\n:')]).toString()).toBe('one\n:');
    expect(filter([Buffer.from('two\n::')]).toString()).toBe('two\n::');
  });

  it('does not rescan later text after a false command candidate', () => {
    for (const input of [
      ': ::warning::ordinary text\n',
      '::  ::warning::ordinary text\n',
      '::1 ::warning::ordinary text\n',
    ]) {
      expect(filter([Buffer.from(input)]).toString()).toBe(input);
    }
  });

  it('streams very long lines without retaining the line', () => {
    const payload = Buffer.alloc(2 * 1024 * 1024, 0x61);
    const chunks = [
      Buffer.from('::set-output::'),
      ...Array.from(
        { length: Math.ceil(payload.length / 8191) },
        (_, index) => payload.subarray(index * 8191, (index + 1) * 8191),
      ),
      Buffer.from('\n'),
    ];
    const output = filter(chunks);

    expect(output.subarray(0, 48).toString()).toContain(
      '[awf blocked workflow command] : :set-output::',
    );
    expect(output.length).toBe(
      payload.length +
      Buffer.byteLength('[awf blocked workflow command] : :set-output::\n'),
    );
    expect(output.subarray(-2)).toEqual(Buffer.from('a\n'));
  });
});
