import { EventEmitter } from 'events';
import * as path from 'path';

/* eslint-disable @typescript-eslint/no-require-imports */
const { BODY_READ_TIMEOUT_MS, readBoundedBody } = require(
  path.join(__dirname, '..', '..', 'containers', 'bounded-query', 'broker', 'framing.js'),
);
/* eslint-enable @typescript-eslint/no-require-imports */

describe('bounded-query body framing deadline', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('terminates a peer that stops sending its request body', async () => {
    jest.useFakeTimers();
    const request = Object.assign(new EventEmitter(), { pause: jest.fn() });

    const result = readBoundedBody(request);
    jest.advanceTimersByTime(BODY_READ_TIMEOUT_MS);

    await expect(result).resolves.toEqual({ error: 'request body deadline exceeded' });
    expect(request.pause).toHaveBeenCalledTimes(1);
  });
});
