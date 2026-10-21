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

  test('launches system Chrome using the staged payload and the runner libc', async () => {
    const result = await createRunner().run(`
      set -eu
      test -n "$LD_LIBRARY_PATH"
      getconf GNU_LIBC_VERSION
      ldd /opt/google/chrome/chrome
      /opt/google/chrome/chrome --headless --no-sandbox --disable-dev-shm-usage \
        --dump-dom 'data:text/html,<title>awf-browser-abi</title>'
    `, {
      allowDomains: ['localhost'],
      skipPull: true,
      logLevel: 'debug',
      timeout: 120000,
    });

    expect(result.timedOut).toBe(false);
    expect(result.stderr).not.toMatch(/version [`']GLIBC_[\d.]+['`] not found/);
    expect(result.stdout).not.toContain('=> not found');
    expect(result.stdout).toMatch(/libasound\.so\.2 => \/run\/awf-lib\/browser-libs\//);
    expect(result.stdout).toMatch(/libc\.so\.6 => \/(?:usr\/)?lib\//);
    expect(result.stdout).toContain('<title>awf-browser-abi</title>');
    expect(result.exitCode).toBe(0);
  }, 180000);
});
