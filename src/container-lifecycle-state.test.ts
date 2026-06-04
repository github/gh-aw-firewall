import { markAgentExternallyKilled, isAgentExternallyKilled } from './container-lifecycle-state';
import { containerLifecycleTestHelpers } from './container-lifecycle.test-utils';

describe('container-lifecycle-state', () => {
  beforeEach(() => {
    containerLifecycleTestHelpers.resetAgentExternallyKilled();
  });

  it('resets externally-killed state via test helpers', () => {
    expect(isAgentExternallyKilled()).toBe(false);
    markAgentExternallyKilled();
    expect(isAgentExternallyKilled()).toBe(true);
    containerLifecycleTestHelpers.resetAgentExternallyKilled();
    expect(isAgentExternallyKilled()).toBe(false);
  });
});
