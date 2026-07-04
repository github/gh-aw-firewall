/**
 * Additional branch coverage for config-file.ts.
 *
 * Covers the String(error) fallback in the parse-error catch block when
 * the thrown value is not an Error instance (BRDA:217,6,1).
 *
 * The stdin path tries JSON.parse first (which fails on non-JSON input),
 * then calls yaml.load. By mocking yaml.load to throw a non-Error value
 * we force the outer catch to take the `String(error)` branch.
 */

jest.mock('js-yaml', () => {
  const actual = jest.requireActual<typeof import('js-yaml')>('js-yaml');
  return { ...actual, load: jest.fn(actual.load) };
});

import * as yaml from 'js-yaml';
import { loadAwfFileConfig } from './config-file';

const mockedLoad = yaml.load as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

describe('loadAwfFileConfig – catch block String(error) fallback', () => {
  it('falls back to String(error) when the thrown parse error is not an Error instance', () => {
    // Make yaml.load throw a number so that `error instanceof Error` is false.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    mockedLoad.mockImplementationOnce(() => { throw 42; });

    // Stdin path: JSON.parse fails on non-JSON content, then yaml.load is called.
    expect(() => loadAwfFileConfig('-', () => 'not-valid-json')).toThrow(
      'Failed to parse AWF config from stdin: 42',
    );
  });
});
