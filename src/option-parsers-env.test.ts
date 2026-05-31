import {
  parseEnvironmentVariables,
  joinShellArgs,
} from './option-parsers';

describe('environment variable parsing', () => {
  it('should parse KEY=VALUE format correctly', () => {
    const envVars = ['GITHUB_TOKEN=abc123', 'API_KEY=xyz789'];
    const result = parseEnvironmentVariables(envVars);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.env).toEqual({
        GITHUB_TOKEN: 'abc123',
        API_KEY: 'xyz789',
      });
    }
  });

  it('should handle empty values', () => {
    const envVars = ['EMPTY_VAR='];
    const result = parseEnvironmentVariables(envVars);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.env).toEqual({
        EMPTY_VAR: '',
      });
    }
  });

  it('should handle values with equals signs', () => {
    const envVars = ['BASE64_VAR=abc=def=ghi'];
    const result = parseEnvironmentVariables(envVars);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.env).toEqual({
        BASE64_VAR: 'abc=def=ghi',
      });
    }
  });

  it('should reject invalid format (no equals sign)', () => {
    const envVars = ['INVALID_VAR'];
    const result = parseEnvironmentVariables(envVars);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.invalidVar).toBe('INVALID_VAR');
    }
  });

  it('should handle empty array', () => {
    const envVars: string[] = [];
    const result = parseEnvironmentVariables(envVars);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.env).toEqual({});
    }
  });

  it('should return error on first invalid entry', () => {
    const envVars = ['VALID_VAR=value', 'INVALID_VAR', 'ANOTHER_VALID=value2'];
    const result = parseEnvironmentVariables(envVars);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.invalidVar).toBe('INVALID_VAR');
    }
  });
});

describe('shell argument joining', () => {
  it('should not escape simple arguments', () => {
    expect(joinShellArgs(['curl'])).toBe('curl');
    expect(joinShellArgs(['https://api.github.com'])).toBe('https://api.github.com');
    expect(joinShellArgs(['/usr/bin/node'])).toBe('/usr/bin/node');
    expect(joinShellArgs(['--log-level=debug'])).toBe('--log-level=debug');
  });

  it('should escape arguments with spaces', () => {
    expect(joinShellArgs(['hello world'])).toBe("'hello world'");
    expect(joinShellArgs(['Authorization: Bearer token'])).toBe("'Authorization: Bearer token'");
  });

  it('should escape arguments with special characters', () => {
    expect(joinShellArgs(['test$var'])).toBe("'test$var'");
    expect(joinShellArgs(['test`cmd`'])).toBe("'test`cmd`'");
    expect(joinShellArgs(['test;echo'])).toBe("'test;echo'");
  });

  it('should escape single quotes in arguments', () => {
    expect(joinShellArgs(["it's"])).toBe("'it'\\''s'");
    expect(joinShellArgs(["don't"])).toBe("'don'\\''t'");
  });

  it('should join multiple arguments with proper escaping', () => {
    expect(joinShellArgs(['curl', 'https://api.github.com'])).toBe('curl https://api.github.com');
    expect(joinShellArgs(['curl', '-H', 'Authorization: Bearer token', 'https://api.github.com']))
      .toBe("curl -H 'Authorization: Bearer token' https://api.github.com");
    expect(joinShellArgs(['echo', 'hello world', 'test']))
      .toBe("echo 'hello world' test");
  });
});

describe('command argument handling with variables', () => {
  it('should preserve $ in single argument for container expansion', () => {
    // Single argument - passed through for container expansion
    const args = ['echo $HOME && echo $USER'];
    const result = args.length === 1 ? args[0] : joinShellArgs(args);
    expect(result).toBe('echo $HOME && echo $USER');
    // $ signs will be escaped to $$ by Docker Compose generator
  });

  it('should escape arguments when multiple provided', () => {
    // Multiple arguments - each escaped
    const args = ['echo', '$HOME', '&&', 'echo', '$USER'];
    const result = args.length === 1 ? args[0] : joinShellArgs(args);
    expect(result).toBe("echo '$HOME' '&&' echo '$USER'");
    // Now $ signs are quoted, won't expand
  });

  it('should handle GitHub Actions style commands', () => {
    // Simulates: awf -- 'cd $GITHUB_WORKSPACE && npm test'
    const args = ['cd $GITHUB_WORKSPACE && npm test'];
    const result = args.length === 1 ? args[0] : joinShellArgs(args);
    expect(result).toBe('cd $GITHUB_WORKSPACE && npm test');
  });

  it('should preserve command substitution', () => {
    // Simulates: awf -- 'echo $(pwd) && echo $(whoami)'
    const args = ['echo $(pwd) && echo $(whoami)'];
    const result = args.length === 1 ? args[0] : joinShellArgs(args);
    expect(result).toBe('echo $(pwd) && echo $(whoami)');
  });
});
