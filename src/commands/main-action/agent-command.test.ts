import { assembleAgentCommand } from './agent-command';

describe('assembleAgentCommand', () => {
  afterEach(() => jest.restoreAllMocks());

  it('preserves a complete shell command for container-side expansion', () => {
    const command = 'echo "$HOME" "$(pwd)" \'literal text\'';
    expect(assembleAgentCommand([command], false)).toBe(command);
  });

  it('quotes shell-parsed arguments without expanding their contents', () => {
    expect(assembleAgentCommand(['printf', '%s', 'two words', '$HOME', "it's"], false))
      .toBe("printf '%s' 'two words' '$HOME' 'it'\\''s'");
  });

  it('assembles the reflect request without a user command', () => {
    expect(assembleAgentCommand([], true))
      .toBe('curl --fail --silent --show-error --noproxy "*" http://api-proxy:10000/reflect');
  });

  it.each([
    [[], false, 'Error: No command specified. Use -- to separate command from options.'],
    [['echo hi'], true, 'Error: --reflect cannot be used with a command.'],
  ] as const)('rejects invalid command inputs', (args, reflect, message) => {
    const output = jest.spyOn(console, 'error').mockImplementation();
    jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    expect(() => assembleAgentCommand([...args], reflect)).toThrow('exit');
    expect(output).toHaveBeenCalledWith(message);
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});
