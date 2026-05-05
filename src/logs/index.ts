/**
 * Log viewing utilities for Squid proxy logs
 */

export { parseLogLine, extractDomain, extractPort } from './log-parser';
export { LogFormatter } from './log-formatter';
export {
  discoverLogSources,
  selectMostRecent,
  isContainerRunning,
  validateSource,
  listLogSources,
} from './log-discovery';
export { streamLogs } from './log-streamer';
export {
  aggregateLogs,
  loadAllLogs,
  loadAndAggregate,
  AggregatedStats,
  DomainStats,
} from './log-aggregator';
export {
  formatStats,
  formatStatsJson,
  formatStatsMarkdown,
  formatStatsPretty,
} from './stats-formatter';
