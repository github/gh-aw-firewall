import { standaloneSkipPullRegex } from './workflow-patch-patterns';

describe('standaloneSkipPullRegex', () => {
  it.each([
    ['awf --skip-pull -- command', 'awf --build-local -- command'],
    ['awf --skip-pull --build-local -- command', 'awf --build-local -- command'],
  ])('normalizes local-build flags in %s', (input, expected) => {
    expect(input.replace(standaloneSkipPullRegex, '--build-local')).toBe(expected);
  });
});
