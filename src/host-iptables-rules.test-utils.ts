/**
 * Test-only re-export of internal helpers from the host iptables validation module.
 * Tests should import from this file, not directly from the production module.
 */
export { iptablesRulesTestHelpers } from './host-iptables-validation';
