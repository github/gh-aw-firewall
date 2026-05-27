import { escapeShellArg, joinShellArgs } from './shell-utils';

describe('escapeShellArg', () => {
  describe('safe characters (no quoting needed)', () => {
    it('should return simple alphanumeric strings as-is', () => {
      expect(escapeShellArg('hello')).toBe('hello');
      expect(escapeShellArg('abc123')).toBe('abc123');
    });

    it('should return strings with allowed safe chars as-is', () => {
      expect(escapeShellArg('file.txt')).toBe('file.txt');
      expect(escapeShellArg('/usr/bin/node')).toBe('/usr/bin/node');
      expect(escapeShellArg('key=value')).toBe('key=value');
      expect(escapeShellArg('host:port')).toBe('host:port');
      expect(escapeShellArg('my-file')).toBe('my-file');
      expect(escapeShellArg('my_var')).toBe('my_var');
    });
  });

  describe('strings requiring quoting', () => {
    it('should wrap strings with spaces in single quotes', () => {
      expect(escapeShellArg('hello world')).toBe("'hello world'");
    });

    it('should wrap strings with dollar signs in single quotes', () => {
      expect(escapeShellArg('$HOME')).toBe("'$HOME'");
    });

    it('should wrap strings with backticks in single quotes', () => {
      expect(escapeShellArg('`cmd`')).toBe("'`cmd`'");
    });

    it('should wrap strings with semicolons in single quotes (command injection prevention)', () => {
      expect(escapeShellArg('; rm -rf /')).toBe("'; rm -rf /'");
    });

    it('should wrap strings with ampersands in single quotes', () => {
      expect(escapeShellArg('a && b')).toBe("'a && b'");
    });

    it('should wrap strings with pipes in single quotes', () => {
      expect(escapeShellArg('a | b')).toBe("'a | b'");
    });

    it('should wrap strings with redirect operators in single quotes', () => {
      expect(escapeShellArg('a > b')).toBe("'a > b'");
      expect(escapeShellArg('a < b')).toBe("'a < b'");
    });

    it('should wrap strings with exclamation marks in single quotes', () => {
      expect(escapeShellArg('hello!')).toBe("'hello!'");
    });

    it('should wrap strings with newlines in single quotes', () => {
      expect(escapeShellArg('line1\nline2')).toBe("'line1\nline2'");
    });
  });

  describe('strings with single quotes (injection prevention)', () => {
    it('should escape single quotes using the standard shell pattern', () => {
      expect(escapeShellArg("it's")).toBe("'it'\\''s'");
    });

    it('should handle strings that are only a single quote', () => {
      expect(escapeShellArg("'")).toBe("''\\'''");
    });

    it('should handle strings with multiple single quotes', () => {
      expect(escapeShellArg("a'b'c")).toBe("'a'\\''b'\\''c'");
    });

    it('should handle injection attempt with single quote and shell metacharacters', () => {
      const injection = "'; rm -rf /; echo '";
      const escaped = escapeShellArg(injection);
      // Should be safely quoted so no shell injection can occur
      // The two surrounding ' chars and the embedded '\'' escapes neutralize all metacharacters
      expect(escaped).toBe("''\\''; rm -rf /; echo '\\'''"  );
    });
  });

  describe('empty and edge cases', () => {
    it('should wrap empty string in single quotes', () => {
      // Empty string does not match the safe-character regex because it requires at least one character,
      // so it should be quoted.
      const result = escapeShellArg('');
      expect(result).toBe("''");
    });

    it('should handle strings with only special characters', () => {
      expect(escapeShellArg('***')).toBe("'***'");
    });
  });
});

describe('joinShellArgs', () => {
  it('should join simple arguments with spaces', () => {
    expect(joinShellArgs(['echo', 'hello'])).toBe('echo hello');
  });

  it('should escape arguments with spaces', () => {
    expect(joinShellArgs(['echo', 'hello world'])).toBe("echo 'hello world'");
  });

  it('should handle empty array', () => {
    expect(joinShellArgs([])).toBe('');
  });

  it('should handle single argument', () => {
    expect(joinShellArgs(['echo'])).toBe('echo');
  });

  it('should properly escape injection attempts in argument list', () => {
    const args = ['cmd', '--flag', '; malicious command'];
    const result = joinShellArgs(args);
    expect(result).toBe("cmd --flag '; malicious command'");
  });

  it('should handle arguments with dollar signs', () => {
    expect(joinShellArgs(['echo', '$SECRET'])).toBe("echo '$SECRET'");
  });
});
