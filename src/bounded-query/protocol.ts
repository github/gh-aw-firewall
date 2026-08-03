/**
 * Compatibility surface for the bounded-query finite-disclosure protocol.
 *
 * The reusable implementation lives in `bounded-execution`; bounded-query
 * imports remain stable so this foundation refactor does not change its public
 * API or emitted bytes.
 */
export * from '../bounded-execution/finite-disclosure';
