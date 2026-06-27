import { applyConfigOptionsInPlaceWithCliPrecedence } from './config-precedence';

describe('applyConfigOptionsInPlaceWithCliPrecedence', () => {
  it('does not overwrite explicitly provided CLI options', () => {
    const options: Record<string, unknown> = { logLevel: 'warn', memoryLimit: '4g' };
    const configOptions: Record<string, unknown> = { logLevel: 'debug', memoryLimit: '8g', imageTag: 'latest' };

    applyConfigOptionsInPlaceWithCliPrecedence(options, configOptions, (name) => name === 'logLevel');

    expect(options).toEqual({ logLevel: 'warn', memoryLimit: '8g', imageTag: 'latest' });
  });

  it('applies all config options when no CLI options provided', () => {
    const options: Record<string, unknown> = {};
    const configOptions: Record<string, unknown> = { logLevel: 'debug', imageTag: 'latest', allowDomains: 'github.com' };

    applyConfigOptionsInPlaceWithCliPrecedence(options, configOptions, () => false);

    expect(options).toEqual({ logLevel: 'debug', imageTag: 'latest', allowDomains: 'github.com' });
  });

  it('skips undefined config values', () => {
    const options: Record<string, unknown> = {};
    const configOptions: Record<string, unknown> = { logLevel: undefined, imageTag: 'latest' };

    applyConfigOptionsInPlaceWithCliPrecedence(options, configOptions, () => false);

    expect(options).toEqual({ imageTag: 'latest' });
    expect('logLevel' in options).toBe(false);
  });

  it('overwrites existing options when CLI did not provide them', () => {
    const options: Record<string, unknown> = { logLevel: 'info' };
    const configOptions: Record<string, unknown> = { logLevel: 'error' };

    applyConfigOptionsInPlaceWithCliPrecedence(options, configOptions, () => false);

    expect(options.logLevel).toBe('error');
  });
});
