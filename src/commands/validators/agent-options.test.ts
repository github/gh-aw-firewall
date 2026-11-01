import * as fs from 'fs';
import * as path from 'path';
import { validateAgentOptions } from './agent-options';
import { logger } from '../../logger';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('../../logger', () => require('../../test-helpers/mock-logger.test-utils').loggerMockFactory());

describe('mount file-scope advisory', () => {
  let inputDir: string;

  beforeEach(() => {
    jest.clearAllMocks();
    inputDir = fs.mkdtempSync('/tmp/awf-detector-input-');
  });

  afterEach(() => {
    fs.chmodSync(inputDir, 0o700);
    fs.rmSync(inputDir, { recursive: true, force: true });
  });

  it.each(['ro', 'rw'])('warns once without changing %s mounts or the detector command', (mode) => {
    const mounts = [
      `${inputDir}:/tmp/gh-aw/threat-detection:${mode}`,
      `${inputDir}:/tmp/gh-aw/other:ro`,
    ];
    const command = '/bin/bash -c \'threat-detect --engine copilot /tmp/gh-aw/threat-detection\'';
    const options = { mount: mounts, command };

    expect(validateAgentOptions(options).volumeMounts).toEqual(mounts);
    expect(options.command).toBe(command);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('not engine file scope'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('engine subprocess'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Copilot --add-dir'));
  });

  it.each(['empty', 'unreadable'])('does not imply input access for an %s detector directory', (state) => {
    if (state === 'unreadable') {
      fs.writeFileSync(path.join(inputDir, 'agent_output.json'), '{}', { mode: 0o600 });
      fs.chmodSync(inputDir, 0);
    }

    validateAgentOptions({ mount: [`${inputDir}:/tmp/gh-aw/threat-detection:rw`] });

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('fail closed on empty or unreadable inputs'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('AWF does not verify engine input access or verdicts'));
  });

  it.each([{}, { mount: [] }])('does not emit a mount advisory without explicit mounts', (options) => {
    expect(validateAgentOptions(options).volumeMounts).toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does not include mount paths or command contents in the advisory', () => {
    validateAgentOptions({ mount: [`${inputDir}:/private/input:ro`], command: 'echo private-prompt' });

    const warning = (logger.warn as jest.Mock).mock.calls[0][0] as string;
    expect(warning).not.toContain(inputDir);
    expect(warning).not.toContain('/private/input');
    expect(warning).not.toContain('private-prompt');
  });

  it.each(['relative', '', '/tmp/input\0', 42])('rejects invalid input directory %p', (input) => {
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    try {
      expect(() => validateAgentOptions({ inputDir: [input] })).toThrow('exit');
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      exit.mockRestore();
    }
  });

  it('accepts sandbox-visible inputs without requiring host visibility', () => {
    expect(() => validateAgentOptions({ inputDir: ['/guest/input'] })).not.toThrow();
  });
});
