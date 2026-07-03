import { ANTHROPIC_ENV, COPILOT_ENV, GEMINI_ENV, OPENAI_ENV } from './api-proxy-env-constants';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const providerEnvConstants = require('../containers/api-proxy/provider-env-constants.js') as {
  OPENAI_ENV: typeof OPENAI_ENV;
  ANTHROPIC_ENV: typeof ANTHROPIC_ENV;
  GEMINI_ENV: typeof GEMINI_ENV;
  COPILOT_ENV: typeof COPILOT_ENV;
};

describe('API proxy provider env constants', () => {
  it('TypeScript host and JS sidecar both load from the same JSON source', () => {
    expect(providerEnvConstants.OPENAI_ENV).toEqual(OPENAI_ENV);
    expect(providerEnvConstants.ANTHROPIC_ENV).toEqual(ANTHROPIC_ENV);
    expect(providerEnvConstants.GEMINI_ENV).toEqual(GEMINI_ENV);
    expect(providerEnvConstants.COPILOT_ENV).toEqual(COPILOT_ENV);
  });
});
