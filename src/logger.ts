import chalk from 'chalk';
import { LogLevel } from './types';

/**
 * Numeric severity for each log level. A message is emitted when its level's
 * value is greater than or equal to the value of the logger's current level.
 */
const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Minimal leveled logger with colored output.
 *
 * All messages are written to stderr via `console.error`, regardless of level.
 * This is intentional: in Node.js, `console.info` and `console.debug` write to
 * stdout, which would interleave log lines with the stdout of the command
 * wrapped by awf and break callers that parse or pipe that output.
 */
class Logger {
  /** Minimum level at which messages are emitted. */
  private level: LogLevel;

  /**
   * @param level - Initial minimum log level (defaults to `'info'`).
   */
  constructor(level: LogLevel = 'info') {
    this.level = level;
  }

  /**
   * Sets the minimum log level; messages below this level are suppressed.
   *
   * @param level - The new minimum log level.
   */
  setLevel(level: LogLevel): void {
    this.level = level;
  }

  /**
   * Returns whether a message at the given level should be emitted under the
   * current minimum log level.
   *
   * @param level - The level of the message being considered.
   */
  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.level];
  }

  /**
   * Logs a gray `[DEBUG]` message to stderr when the level is `debug`.
   *
   * @param message - The message to log.
   * @param args - Additional values passed through to `console.error`.
   */
  debug(message: string, ...args: unknown[]): void {
    if (this.shouldLog('debug')) {
      console.error(chalk.gray(`[DEBUG] ${message}`), ...args);
    }
  }

  /**
   * Logs a blue `[INFO]` message to stderr when the level is `info` or lower.
   *
   * @param message - The message to log.
   * @param args - Additional values passed through to `console.error`.
   */
  info(message: string, ...args: unknown[]): void {
    if (this.shouldLog('info')) {
      console.error(chalk.blue(`[INFO] ${message}`), ...args);
    }
  }

  /**
   * Logs a yellow `[WARN]` message to stderr when the level is `warn` or lower.
   *
   * @param message - The message to log.
   * @param args - Additional values passed through to `console.error`.
   */
  warn(message: string, ...args: unknown[]): void {
    if (this.shouldLog('warn')) {
      console.error(chalk.yellow(`[WARN] ${message}`), ...args);
    }
  }

  /**
   * Logs a red `[ERROR]` message to stderr. Emitted at every log level.
   *
   * @param message - The message to log.
   * @param args - Additional values passed through to `console.error`.
   */
  error(message: string, ...args: unknown[]): void {
    if (this.shouldLog('error')) {
      console.error(chalk.red(`[ERROR] ${message}`), ...args);
    }
  }

  /**
   * Logs a green `[SUCCESS]` message to stderr. Shares the `info` threshold.
   *
   * @param message - The message to log.
   * @param args - Additional values passed through to `console.error`.
   */
  success(message: string, ...args: unknown[]): void {
    if (this.shouldLog('info')) {
      console.error(chalk.green(`[SUCCESS] ${message}`), ...args);
    }
  }
}

/** Shared process-wide logger instance used throughout the CLI. */
export const logger = new Logger();
