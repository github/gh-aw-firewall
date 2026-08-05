import * as fs from 'fs';
import {
  type SbxIngressCapabilities,
  writeSbxIngressCapabilitiesFile,
} from './sbx-ingress-capabilities';

const capabilities: SbxIngressCapabilities = {
  version: 1,
  query: 'a'.repeat(64),
  probe: 'b'.repeat(64),
};

function createFileOps(overrides: Record<string, jest.Mock> = {}) {
  return {
    open: overrides.open ?? jest.fn(() => 42),
    write: overrides.write ?? jest.fn(),
    chmod: overrides.chmod ?? jest.fn(),
    close: overrides.close ?? jest.fn(),
  };
}

describe('writeSbxIngressCapabilitiesFile', () => {
  it('writes the unchanged payload with exclusive no-follow creation and mode hardening', () => {
    const fileOps = createFileOps();

    writeSbxIngressCapabilitiesFile('/private/capabilities.json', capabilities, fileOps);

    expect(fileOps.open).toHaveBeenCalledWith(
      '/private/capabilities.json',
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    expect(fileOps.write).toHaveBeenCalledWith(42, JSON.stringify(capabilities));
    expect(fileOps.chmod).toHaveBeenCalledWith(42, 0o600);
    expect(fileOps.close).toHaveBeenCalledWith(42);
    expect(fileOps.write.mock.invocationCallOrder[0])
      .toBeLessThan(fileOps.chmod.mock.invocationCallOrder[0]);
    expect(fileOps.chmod.mock.invocationCallOrder[0])
      .toBeLessThan(fileOps.close.mock.invocationCallOrder[0]);
  });

  it.each(['write', 'chmod'] as const)('closes the descriptor and propagates a %s failure', (operation) => {
    const failure = new Error(`${operation} failed`);
    const fileOps = createFileOps({ [operation]: jest.fn(() => { throw failure; }) });

    expect(() => writeSbxIngressCapabilitiesFile('/private/capabilities.json', capabilities, fileOps))
      .toThrow(failure);
    expect(fileOps.close).toHaveBeenCalledWith(42);
  });

  it('propagates an open failure without attempting file operations', () => {
    const failure = new Error('open failed');
    const fileOps = createFileOps({ open: jest.fn(() => { throw failure; }) });

    expect(() => writeSbxIngressCapabilitiesFile('/private/capabilities.json', capabilities, fileOps))
      .toThrow(failure);
    expect(fileOps.write).not.toHaveBeenCalled();
    expect(fileOps.chmod).not.toHaveBeenCalled();
    expect(fileOps.close).not.toHaveBeenCalled();
  });

  it('propagates a close failure', () => {
    const failure = new Error('close failed');
    const fileOps = createFileOps({ close: jest.fn(() => { throw failure; }) });

    expect(() => writeSbxIngressCapabilitiesFile('/private/capabilities.json', capabilities, fileOps))
      .toThrow(failure);
  });
});
