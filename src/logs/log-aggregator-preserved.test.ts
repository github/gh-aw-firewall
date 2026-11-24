import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadAndAggregate } from './log-aggregator';
import { formatStats } from './stats-formatter';

/* eslint-disable security/detect-non-literal-fs-filename -- paths are inside the test's temporary directory */
it('uses structured audit records for preserved log statistics when both formats exist', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-log-stats-'));
  try {
    const common = { _schema: 'audit/v0.0.0-dev', event: 'http_access', client: '172.30.0.20', method: 'CONNECT' };
    fs.writeFileSync(path.join(directory, 'access.log'),
      '1700000000.000 172.30.0.20:40000 other.example:443 192.0.2.1:443 1.1 CONNECT 200 TCP_TUNNEL:HIER_DIRECT other.example:443 "-"\n');
    fs.writeFileSync(path.join(directory, 'audit.jsonl'), [
      { ...common, timestamp: '2023-11-14T22:13:20.000Z', host: 'api.example:443', dest: '192.0.2.1:443', status: 200, decision: 'TCP_TUNNEL', url: 'api.example:443' },
      { ...common, timestamp: '2023-11-14T22:13:21.000Z', host: 'api.example:443', dest: '-:-', status: 403, decision: 'TCP_DENIED', url: 'api.example:443' },
      { ...common, timestamp: '2023-11-14T22:13:22.000Z', host: 'other.example:443', dest: '192.0.2.1:443', status: 200, decision: 'TCP_TUNNEL', url: 'other.example:443' },
    ].map(record => JSON.stringify(record)).join('\n'));

    const stats = await loadAndAggregate({ type: 'preserved', path: directory });
    expect(JSON.parse(formatStats(stats, 'json'))).toEqual({
      totalRequests: 3,
      allowedRequests: 2,
      deniedRequests: 1,
      uniqueDomains: 2,
      timeRange: { start: 1700000000, end: 1700000002 },
      byDomain: {
        'api.example': { allowed: 1, denied: 1, total: 2 },
        'other.example': { allowed: 1, denied: 0, total: 1 },
      },
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
