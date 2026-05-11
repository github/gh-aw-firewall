/**
 * Logger level type.
 */

/**
 * Logging level type for controlling output verbosity
 * 
 * The logger filters messages based on this level. Each level includes
 * all messages from higher severity levels:
 * - 'debug' (0): Shows all messages
 * - 'info' (1): Shows info, warn, and error
 * - 'warn' (2): Shows warn and error
 * - 'error' (3): Shows only errors
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
