/**
 * Tests for logs-stats command
 */

import { statsCommand } from './logs-stats';

type StatsCommandOptions = Parameters<typeof statsCommand>[0];
import { logger } from '../logger';
import {
  createLogCommandTests,
  createLogCommandTestHarness,
  setupEmptyStatsHarness,
} from './test-helpers.test-utils';

// Mock dependencies
jest.mock('../logs/log-discovery');
jest.mock('../logs/log-aggregator');
jest.mock('../logs/stats-formatter');
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('../logger', () => require('../test-helpers/mock-logger.test-utils').loggerMockFactory());

createLogCommandTests<StatsCommandOptions>(
  'stats',
  statsCommand,
  'pretty',
  (overrides?) => ({ format: 'pretty', ...overrides } as StatsCommandOptions),
);

describe('logs-stats command - logging behavior', () => {
  const harness = createLogCommandTestHarness();

  it('should emit source-selection info logs for non-JSON formats but suppress them for JSON', async () => {
    const mockSource = {
      type: 'preserved' as const,
      path: '/tmp/squid-logs-123',
      dateStr: 'Mon Jan 01 2024',
    };
    setupEmptyStatsHarness(harness, mockSource);

    // pretty: shouldLog returns true → logger.info should be called
    await statsCommand({ format: 'pretty' });
    expect((logger.info as jest.Mock)).toHaveBeenCalled();
    (logger.info as jest.Mock).mockClear();

    // markdown: shouldLog returns true → logger.info should be called
    await statsCommand({ format: 'markdown' });
    expect((logger.info as jest.Mock)).toHaveBeenCalled();
    (logger.info as jest.Mock).mockClear();

    // json: shouldLog returns false → logger.info should NOT be called
    await statsCommand({ format: 'json' });
    expect((logger.info as jest.Mock)).not.toHaveBeenCalled();
  });
});
