/**
 * Test-only re-export of internal state-reset helpers from host-iptables-shared.
 * Tests should import from this file, not directly from the production module.
 */
export { iptablesSharedTestHelpers } from './host-iptables-shared';
