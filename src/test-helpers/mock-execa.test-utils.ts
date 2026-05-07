/**
 * Shared jest.mock factory for the 'execa' module.
 *
 * Usage in test files:
 *   import { mockExecaFn, mockExecaSync } from './test-helpers/mock-execa.test-utils';
 *   jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());
 */

export const mockExecaFn = jest.fn();
export const mockExecaSync = jest.fn();

export function execaMockFactory() {
  const fn = (...args: any[]) => mockExecaFn(...args);
  fn.sync = (...args: any[]) => mockExecaSync(...args);
  return fn;
}
