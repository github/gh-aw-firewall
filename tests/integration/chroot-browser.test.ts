import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { createRunner } from '../fixtures/awf-runner';
import { cleanup } from '../fixtures/cleanup';

describe('Browser launch with chroot-staged libraries', () => {
  beforeAll(async () => {
    await cleanup(false);
  });

  afterAll(async () => {
    await cleanup(false);
  });

  test.each([false, true])('launches Chrome with a masked runner audio-library path: %s', async (maskAudioLibraryPath) => {
    const result = await createRunner().run(`
      set -eu
      ${maskAudioLibraryPath ? 'test -n "${LD_LIBRARY_PATH:-}"' : ''}
      getconf GNU_LIBC_VERSION
      gio version
      ldd /opt/google/chrome/chrome
      /opt/google/chrome/chrome --headless --no-sandbox --disable-dev-shm-usage \
        --dump-dom 'data:text/html,<title>awf-browser-abi</title>'
    `, {
      allowDomains: ['localhost'],
      skipPull: true,
      logLevel: 'debug',
      timeout: 120000,
      // Mask the payload's /usr path while leaving the runner's /lib alias
      // available; fallback staging must not replace that native library.
      volumeMounts: maskAudioLibraryPath
        ? ['/dev/null:/usr/lib/x86_64-linux-gnu/libasound.so.2:ro']
        : [],
    });

    expect(result).toEqual(expect.objectContaining({ exitCode: 0, timedOut: false }));
    expect(result.stderr).not.toMatch(/version [`']GLIBC_[\d.]+['`] not found/);
    expect(result.stdout).not.toContain('=> not found');
    expect(result.stdout).toMatch(/libasound\.so\.2 => \/(?:usr\/)?lib\//);
    expect(result.stdout).toMatch(/libc\.so\.6 => \/(?:usr\/)?lib\//);
    expect(result.stdout).toContain('<title>awf-browser-abi</title>');
  }, 180000);
});
