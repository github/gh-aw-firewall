/**
 * Shared jest.mock factory for the logger module.
 *
 * Usage in test files (adjust relative path as needed):
 *   jest.mock('./logger', () => require('./test-helpers/mock-logger.test-utils').loggerMockFactory());
 *   jest.mock('../logger', () => require('../test-helpers/mock-logger.test-utils').loggerMockFactory());
 */

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
};

export function loggerMockFactory() {
  return { logger: mockLogger };
}
