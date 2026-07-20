import { buildExclusionSet } from '../../src/services/agent-environment/excluded-vars';
import { WrapperConfig } from '../../src/types';

// ANTHROPIC_AUTH_TOKEN must never reach the agent container.
//
// Previously this was asserted by scanning every compiled Claude lock file for
// a `--exclude-env ANTHROPIC_AUTH_TOKEN` flag emitted by the gh-aw compiler.
// That compiler-emitted flag is redundant: awf always strips ANTHROPIC_AUTH_TOKEN
// from the agent environment via buildExclusionSet() whenever the API proxy is
// enabled (which is always the case for these workflows). The token is held only
// in the API proxy sidecar. We therefore assert the awf-level invariant directly,
// which holds regardless of the gh-aw version used to compile the lock files.
function makeConfig(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    allowDomains: [],
    ...overrides,
  } as WrapperConfig;
}

describe('Anthropic auth token workflow protection', () => {
  it('awf excludes ANTHROPIC_AUTH_TOKEN from the agent when the API proxy is enabled', () => {
    const set = buildExclusionSet(makeConfig({ enableApiProxy: true }));
    expect(set.has('ANTHROPIC_AUTH_TOKEN')).toBe(true);
    expect(set.has('ANTHROPIC_API_KEY')).toBe(true);
  });
});
