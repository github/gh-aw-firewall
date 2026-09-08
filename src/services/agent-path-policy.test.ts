import { normalizeMountedChrootTarget } from './agent-path-policy';

describe('normalizeMountedChrootTarget', () => {
  it.each([
    ['/host', '/'],
    ['/host/workspace', '/workspace'],
    ['/workspace', '/workspace'],
  ])('normalizes %s to %s', (target, expected) => {
    expect(normalizeMountedChrootTarget(target)).toBe(expected);
  });
});
