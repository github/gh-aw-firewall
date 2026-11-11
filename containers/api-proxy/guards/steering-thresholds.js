'use strict';

const crypto = require('crypto');

const BUDGET_WARNING_THRESHOLDS = [80, 90, 95, 99];

/**
 * Upper bound on conversations remembered per notice kind. When full, the
 * conversation that received a notice least recently is dropped; if it comes
 * back it hears the current notice once more.
 */
const MAX_STEERING_CONVERSATIONS = 1024;

/**
 * Conversation key shared by all Responses requests that continue a stored
 * response (`previous_response_id` or a non-null `conversation`). They carry
 * no history to hash, so together they are one entry in the per-conversation
 * table: each notice goes to one of them per run, independently of hashed
 * conversations. Conversation keys are hex, so this key never collides with one.
 */
const STORED_RESPONSE_CONVERSATION = 'stored-response';

/**
 * Secret for conversation keys, generated when the proxy starts. It is kept in
 * memory only (never logged, written or reflected), so a conversation key is
 * an opaque identifier that is comparable only within one proxy process and
 * does not reveal the prompt content it was derived from. A restart changes
 * every key, so each conversation hears the current notice once more.
 */
let conversationKeySecret = crypto.randomBytes(32);

/**
 * Opaque conversation key (hex HMAC-SHA-256 under the per-process secret) for
 * a canonical serialisation of a conversation's opening.
 *
 * @param {string} opening
 * @returns {string}
 */
function steeringConversationKey(opening) {
  return crypto.createHmac('sha256', conversationKeySecret).update(opening).digest('hex');
}

/** Replace the conversation-key secret, as a proxy restart would. */
function resetSteeringConversationSecretForTests() {
  conversationKeySecret = crypto.randomBytes(32);
}

/**
 * Delivery state for one notice kind (time or AI credits).
 *
 * - `pending` / `inFlight`: run-level state for requests that have no
 *   conversation key (a history with no opening to hash). Each notice goes to
 *   one such request per run.
 * - `conversations`: conversation key (steeringConversationKey() or
 *   STORED_RESPONSE_CONVERSATION) -> latest threshold delivered to it,
 *   in least-recently-delivered order and capped at MAX_STEERING_CONVERSATIONS.
 * - `conversationInFlight`: conversation key -> threshold -> in-flight count.
 * - `recorded`: thresholds already delivered somewhere in the run, so the
 *   run-level `steering` record field is written once per threshold.
 */
function createSteeringDeliveryState() {
  return {
    pending: new Set(),
    inFlight: new Map(),
    conversations: new Map(),
    conversationInFlight: new Map(),
    recorded: new Set(),
  };
}

/**
 * Select the next budget notice to deliver for one notice kind.
 *
 * A pending threshold is only eligible when it is higher than every notice of
 * the same kind that is still in flight, so an older notice never follows a
 * newer one and concurrent requests do not repeat an undelivered notice.
 *
 * @param {Set<number>} pending - Crossed thresholds not yet delivered
 * @param {Map<number, number>} inFlight - Threshold -> in-flight request count
 * @returns {number|null}
 */
function selectPendingSteeringThreshold(pending, inFlight) {
  const floor = inFlight.size > 0 ? Math.max(...inFlight.keys()) : -Infinity;
  let threshold = null;
  for (const candidate of pending) {
    if (candidate > floor && (threshold === null || candidate > threshold)) threshold = candidate;
  }
  return threshold;
}

/**
 * Select the notice a request should carry.
 *
 * Without a conversation this is the run-level pending notice. With one, it is
 * the latest crossed threshold, unless that conversation has already received
 * it or has a request carrying it (or a newer one) in flight.
 *
 * @param {ReturnType<typeof createSteeringDeliveryState>} delivery
 * @param {Set<number>} crossed - Thresholds crossed so far in the run
 * @param {string|null} [conversation] - Conversation key
 * @returns {number|null}
 */
function selectSteeringThreshold(delivery, crossed, conversation = null) {
  if (!conversation) return selectPendingSteeringThreshold(delivery.pending, delivery.inFlight);
  if (crossed.size === 0) return null;
  const current = Math.max(...crossed);
  const delivered = delivery.conversations.get(conversation);
  if (delivered !== undefined && delivered >= current) return null;
  const inFlight = delivery.conversationInFlight.get(conversation);
  if (inFlight && inFlight.size > 0 && Math.max(...inFlight.keys()) >= current) return null;
  return current;
}

/** Mark a notice as delivered and drop older pending notices it supersedes. */
function acknowledgeSteeringThreshold(pending, threshold) {
  for (const candidate of pending) {
    if (candidate <= threshold) pending.delete(candidate);
  }
}

function recordConversationDelivery(conversations, conversation, threshold) {
  const previous = conversations.get(conversation);
  conversations.delete(conversation);
  conversations.set(conversation, previous === undefined ? threshold : Math.max(previous, threshold));
  while (conversations.size > MAX_STEERING_CONVERSATIONS) {
    conversations.delete(conversations.keys().next().value);
  }
}

/**
 * Reserve a notice for a request carrying it. The returned handle settles
 * once: `acknowledge()` after the request succeeds, or `release()` after it
 * fails, leaving the notice pending for the next request.
 *
 * Acknowledging drops the notice and any older ones from the run-level pending
 * set and, for a conversation, records that it has heard this notice. It
 * returns true only for the first delivery of this threshold in the run.
 *
 * @param {ReturnType<typeof createSteeringDeliveryState>} delivery
 * @param {number} threshold
 * @param {string|null} [conversation] - Conversation key
 * @returns {{ acknowledge: () => boolean, release: () => void }}
 */
function claimSteeringThreshold(delivery, threshold, conversation = null) {
  let inFlight = delivery.inFlight;
  if (conversation) {
    inFlight = delivery.conversationInFlight.get(conversation);
    if (!inFlight) {
      inFlight = new Map();
      delivery.conversationInFlight.set(conversation, inFlight);
    }
  }
  inFlight.set(threshold, (inFlight.get(threshold) || 0) + 1);
  let settled = false;
  const settle = (delivered) => {
    if (settled) return false;
    settled = true;
    const remaining = (inFlight.get(threshold) || 1) - 1;
    if (remaining > 0) inFlight.set(threshold, remaining);
    else inFlight.delete(threshold);
    if (conversation && inFlight.size === 0 &&
      delivery.conversationInFlight.get(conversation) === inFlight) {
      delivery.conversationInFlight.delete(conversation);
    }
    if (!delivered) return false;
    acknowledgeSteeringThreshold(delivery.pending, threshold);
    if (conversation) recordConversationDelivery(delivery.conversations, conversation, threshold);
    const first = !delivery.recorded.has(threshold);
    delivery.recorded.add(threshold);
    return first;
  };
  return Object.freeze({
    acknowledge: () => settle(true),
    release: () => { settle(false); },
  });
}

module.exports = {
  BUDGET_WARNING_THRESHOLDS,
  MAX_STEERING_CONVERSATIONS,
  STORED_RESPONSE_CONVERSATION,
  steeringConversationKey,
  resetSteeringConversationSecretForTests,
  createSteeringDeliveryState,
  selectPendingSteeringThreshold,
  selectSteeringThreshold,
  acknowledgeSteeringThreshold,
  claimSteeringThreshold,
};
