import * as fs from 'fs';
import * as path from 'path';
import { checkSquidLogs } from './squid-log-reader';
import { useTempDir } from './test-helpers/docker-test-fixtures.test-utils';

describe('squid-log-reader', () => {
  const { getDir } = useTempDir();

  it('returns no denials when the access log is missing', async () => {
    await expect(checkSquidLogs(getDir())).resolves.toEqual({
      hasDenials: false,
      blockedTargets: [],
    });
  });

  it('parses denied targets and deduplicates repeated entries', async () => {
    const squidLogsDir = path.join(getDir(), 'squid-logs');
    fs.mkdirSync(squidLogsDir, { recursive: true });
    fs.writeFileSync(
      path.join(squidLogsDir, 'access.log'),
      '1760994429.358 172.30.0.20:36274 blocked.com:443 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE blocked.com:443 "curl/7.81.0"\n' +
      '1760994430.000 172.30.0.20:36275 blocked.com:443 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE blocked.com:443 "curl/7.81.0"\n' +
      '1760994430.500 172.30.0.20:36275 blocked-http.com:80 -:- 1.1 GET 403 TCP_DENIED:HIER_NONE http://blocked-http.com/exfil "curl/7.81.0"\n' +
      '1760994431.000 172.30.0.20:36276 [::1]:8443 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE [::1]:8443 "curl/7.81.0"\n'
    );

    await expect(checkSquidLogs(getDir())).resolves.toEqual({
      hasDenials: true,
      blockedTargets: [
        { target: 'blocked.com:443', domain: 'blocked.com', port: '443' },
        { target: 'blocked-http.com:80', domain: 'blocked-http.com', port: '80' },
        { target: '[::1]:8443', domain: '[::1]', port: '8443' },
      ],
    });
  });
});
