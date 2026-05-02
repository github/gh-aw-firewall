import { validateWithSchema } from './schema-validator';

describe('schema-validator', () => {
  describe('validateWithSchema', () => {
    it('returns empty array for valid config', () => {
      expect(validateWithSchema({})).toEqual([]);
      expect(validateWithSchema({ network: { allowDomains: ['github.com'] } })).toEqual([]);
    });

    it('rejects non-object roots', () => {
      expect(validateWithSchema(null)).toEqual(['config root must be an object']);
      expect(validateWithSchema('string')).toEqual(['config root must be an object']);
      expect(validateWithSchema(42)).toEqual(['config root must be an object']);
      expect(validateWithSchema([])).toEqual(['config root must be an object']);
      expect(validateWithSchema(undefined)).toEqual(['config root must be an object']);
    });

    it('formats additionalProperties as "is not supported"', () => {
      const errors = validateWithSchema({ unknownKey: true });
      expect(errors).toContain('config.unknownKey is not supported');
    });

    it('formats nested additionalProperties', () => {
      const errors = validateWithSchema({ network: { badField: true } });
      expect(errors).toContain('config.network.badField is not supported');
    });

    it('formats type:object errors as "must be an object"', () => {
      const errors = validateWithSchema({ network: 'not-object' });
      expect(errors).toContain('config.network must be an object');
    });

    it('formats array-of-strings fields correctly when given non-array', () => {
      const errors = validateWithSchema({ network: { allowDomains: 'github.com' } });
      expect(errors).toContain('config.network.allowDomains must be an array of strings');
    });

    it('formats array-of-strings fields when items have wrong type', () => {
      const errors = validateWithSchema({ network: { blockDomains: [1, 2] } });
      expect(errors).toContain('config.network.blockDomains must be an array of strings');
    });

    it('formats integer with minimum:1 as "must be a positive integer"', () => {
      // Non-integer value
      expect(validateWithSchema({ container: { agentTimeout: 1.5 } }))
        .toContain('config.container.agentTimeout must be a positive integer');
      // String value
      expect(validateWithSchema({ container: { agentTimeout: 'five' } }))
        .toContain('config.container.agentTimeout must be a positive integer');
      // Below minimum
      expect(validateWithSchema({ container: { agentTimeout: 0 } }))
        .toContain('config.container.agentTimeout must be a positive integer');
      expect(validateWithSchema({ container: { agentTimeout: -1 } }))
        .toContain('config.container.agentTimeout must be a positive integer');
    });

    it('formats enum errors as "must be one of"', () => {
      const errors = validateWithSchema({ apiProxy: { anthropicCacheTailTtl: '10m' } });
      expect(errors).toContain('config.apiProxy.anthropicCacheTailTtl must be one of: 5m, 1h');
    });

    it('formats logLevel enum correctly', () => {
      const errors = validateWithSchema({ logging: { logLevel: 'verbose' } });
      expect(errors).toContain('config.logging.logLevel must be one of: debug, info, warn, error');
    });

    it('formats oneOf (string-or-array) fields correctly', () => {
      // Number is neither string nor array
      const errors = validateWithSchema({ security: { allowHostPorts: 5432 } });
      expect(errors).toContain('config.security.allowHostPorts must be a string or array of strings');
    });

    it('accepts string and array forms for oneOf fields', () => {
      expect(validateWithSchema({ security: { allowHostPorts: '5432' } })).toEqual([]);
      expect(validateWithSchema({ security: { allowHostPorts: ['5432', '6379'] } })).toEqual([]);
    });

    it('formats boolean type errors', () => {
      const errors = validateWithSchema({ apiProxy: { enabled: 'yes' } });
      expect(errors).toContain('config.apiProxy.enabled must be a boolean');
    });

    it('formats string type errors for non-array fields', () => {
      const errors = validateWithSchema({ container: { memoryLimit: 512 } });
      expect(errors).toContain('config.container.memoryLimit must be a string');
    });

    it('consolidates multiple item-level errors into one message', () => {
      // Array with 3 non-string items should produce 1 error, not 3
      const errors = validateWithSchema({ network: { dnsServers: [1, 2, 3] } });
      const dnsErrors = errors.filter(e => e.includes('dnsServers'));
      expect(dnsErrors).toHaveLength(1);
      expect(dnsErrors[0]).toBe('config.network.dnsServers must be an array of strings');
    });

    it('handles rateLimiting integer fields', () => {
      expect(validateWithSchema({ rateLimiting: { requestsPerMinute: 0 } }))
        .toContain('config.rateLimiting.requestsPerMinute must be a positive integer');
      expect(validateWithSchema({ rateLimiting: { requestsPerHour: -1 } }))
        .toContain('config.rateLimiting.requestsPerHour must be a positive integer');
      expect(validateWithSchema({ rateLimiting: { bytesPerMinute: 'lots' } }))
        .toContain('config.rateLimiting.bytesPerMinute must be a positive integer');
    });

    it('returns multiple errors for multiple issues', () => {
      const errors = validateWithSchema({
        unknownTop: true,
        network: { allowDomains: 'not-array' },
        container: { agentTimeout: -5 },
      });
      expect(errors.length).toBeGreaterThanOrEqual(3);
    });

    it('validates models as object with string-array values', () => {
      expect(validateWithSchema({ apiProxy: { models: { 'gpt-4o': ['alias1'] } } })).toEqual([]);
      const errors = validateWithSchema({ apiProxy: { models: { 'gpt-4o': 'not-array' } } });
      expect(errors.length).toBeGreaterThan(0);
    });
  });
});
