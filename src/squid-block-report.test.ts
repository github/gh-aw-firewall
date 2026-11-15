import * as fs from 'fs';
import * as path from 'path';
import { fixSquidLogPermissions } from './container-stop';
import { logger } from './logger';
import { reportSquidBlocks } from './squid-block-report';
import { useTempDir } from './test-helpers/docker-test-fixtures.test-utils';

jest.mock('./container-stop', () => ({
  fixSquidLogPermissions: jest.fn(),
}));

const deniedEntry = '1760994429.358 172.30.0.20:36274 blocked.com:443 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE blocked.com:443 "curl/7.81.0"\n';

describe('post-run Squid block reporting', () => {
  const { getDir } = useTempDir();

  beforeEach(() => {
    jest.useFakeTimers();
    jest.mocked(fixSquidLogPermissions).mockReset().mockResolvedValue(undefined);
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('waits for logs to flush and repairs permissions before reading the custom log directory', async () => {
    const proxyLogsDir = path.join(getDir(), 'custom-logs');
    fs.mkdirSync(proxyLogsDir);
    jest.mocked(fixSquidLogPermissions).mockImplementationOnce(async () => {
      await Promise.resolve();
      fs.writeFileSync(path.join(proxyLogsDir, 'access.log'), deniedEntry);
    });

    const result = reportSquidBlocks(getDir(), ['github.com'], 1, proxyLogsDir);
    await jest.advanceTimersByTimeAsync(199);
    expect(fixSquidLogPermissions).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toEqual(['blocked.com']);
    expect(fixSquidLogPermissions).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('Firewall blocked domains:');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('blocked.com:443 (domain not in allowlist)'));
    expect(logger.warn).toHaveBeenCalledWith('To fix domain issues: --allow-domains "github.com,blocked.com"');
  });

  it('returns denied domains without warnings when the agent succeeded', async () => {
    const squidLogsDir = path.join(getDir(), 'squid-logs');
    fs.mkdirSync(squidLogsDir);
    fs.writeFileSync(path.join(squidLogsDir, 'access.log'), deniedEntry);

    const result = reportSquidBlocks(getDir(), [], 0);
    await jest.advanceTimersByTimeAsync(200);

    await expect(result).resolves.toEqual(['blocked.com']);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns no domains or warnings when the access log is absent', async () => {
    const result = reportSquidBlocks(getDir(), [], 1);
    await jest.advanceTimersByTimeAsync(200);

    await expect(result).resolves.toEqual([]);
    expect(fixSquidLogPermissions).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
