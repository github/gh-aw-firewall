import {
  parseNamespaceLink,
  parseNumericEntries,
  parseNumericFields,
  parseNumericLines,
  parseProcessStartTime,
  parseSingleNumber,
  parseStatus,
  parseUnifiedCgroup,
} from './confinement-verify';

describe('NVX confinement proc parsers', () => {
  it('parses status fields and ignores lines without a field name', () => {
    expect(parseStatus('Uid:\t1000 1000 1000 1000\nignored\n:ignored\nName:\tworker: 1\n'))
      .toEqual({ Uid: '1000 1000 1000 1000', Name: 'worker: 1' });
  });

  it('reads start time after the last command-name parenthesis without losing precision', () => {
    const fields = ['S', ...Array(18).fill('0'), '9007199254740993', '0'];
    expect(parseProcessStartTime(`4242 (openvmm (worker)) ${fields.join(' ')}`))
      .toBe('9007199254740993');
  });

  it.each(['', '4242 (openvmm) S 0', `4242 (openvmm) S ${Array(19).fill('x').join(' ')}`])(
    'rejects malformed process stat %j',
    (contents) => {
      expect(() => parseProcessStartTime(contents)).toThrow('NVX process stat is malformed');
    },
  );

  it('extracts one unified cgroup membership while ignoring other controllers', () => {
    expect(parseUnifiedCgroup('1:memory:/legacy\n0::/awf-nvx/run\n')).toBe('/awf-nvx/run');
  });

  it.each(['', '1:memory:/legacy\n', '0::/one\n0::/two\n'])(
    'rejects missing or ambiguous unified membership %j',
    (contents) => {
      expect(() => parseUnifiedCgroup(contents)).toThrow('not in one unified cgroup');
    },
  );

  it.each(['net:[4026533000]', 'mnt:[4026533000]'])(
    'parses namespace inode from %s',
    (value) => {
      expect(parseNamespaceLink(value, 'test')).toBe('4026533000');
    },
  );

  it.each(['net:4026533000', 'mnt:[invalid]', 'pid:[4026533000]'])(
    'rejects malformed namespace link %s',
    (value) => {
      expect(() => parseNamespaceLink(value, 'test')).toThrow('namespace link is malformed');
    },
  );

  it('sorts numeric task entries and cgroup lines, but preserves identity field order', () => {
    expect(parseNumericEntries(['10', '2'], 'task')).toEqual([2, 10]);
    expect(parseNumericLines('10\n\n2\n', 'cgroup.procs')).toEqual([2, 10]);
    expect(parseNumericFields(' 10\t2  3\n', 'Uid')).toEqual([10, 2, 3]);
    expect(parseSingleNumber(String(Number.MAX_SAFE_INTEGER), 'Pid'))
      .toBe(Number.MAX_SAFE_INTEGER);
  });

  it('allows empty numeric lines and fields but rejects an empty task list', () => {
    expect(parseNumericLines('\n', 'cgroup.procs')).toEqual([]);
    expect(parseNumericFields(' \t\n', 'Groups')).toEqual([]);
    expect(() => parseNumericEntries([], 'task')).toThrow('NVX task list is empty');
  });

  it.each([undefined, '', '-1', '1.5', ' 1', '1x', '9007199254740992'])(
    'rejects malformed or unsafe numeric values %j',
    (value) => {
      expect(() => parseSingleNumber(value, 'Pid')).toThrow(/NVX Pid is (malformed|unsafe)/);
    },
  );

  it('propagates numeric validation errors from every list parser', () => {
    expect(() => parseNumericEntries(['1', 'invalid'], 'task')).toThrow('NVX task is malformed');
    expect(() => parseNumericLines('1\ninvalid\n', 'cgroup.procs'))
      .toThrow('NVX cgroup.procs is malformed');
    expect(() => parseNumericFields('1 invalid', 'Uid')).toThrow('NVX Uid is malformed');
  });
});
