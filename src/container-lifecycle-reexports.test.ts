import * as containerLifecycle from './container-lifecycle';
import { startContainers } from './container-startup';
import { runAgentCommand, fastKillAgentContainer } from './agent-run';

describe('container-lifecycle re-exports', () => {
  it('preserves the public lifecycle API without wrapping the implementations', () => {
    expect(containerLifecycle).toEqual({
      startContainers,
      runAgentCommand,
      fastKillAgentContainer,
    });
  });
});
