'use strict';

const { injectSteeringMessage, describeSteeringConversation } = require('./body-transform');
const { logRequest } = require('./logging');
const {
  getPendingTimeoutSteeringWarning,
  hasCrossedTimeoutSteeringThreshold,
  claimTimeoutSteeringWarning,
} = require('./guards/timeout-steering');
const {
  getPendingAiCreditSteeringWarning,
  hasCrossedAiCreditSteeringThreshold,
  claimAiCreditSteeringWarning,
} = require('./guards/ai-credits-guard');
const { STORED_RESPONSE_CONVERSATION } = require('./guards/steering-thresholds');

/** When false, token-budget warnings are never injected into request bodies. */
const isSteeringEnabled = () => process.env.AWF_ENABLE_TOKEN_STEERING === 'true';

/**
 * Select, inject, and claim the highest-ranked eligible conversation notice.
 *
 * @param {Buffer} body
 * @param {string} provider
 * @param {import('http').IncomingMessage} req
 * @param {string} requestId
 * @returns {{ body: Buffer, steering: object|null }}
 */
function injectRequestSteering(body, provider, req, requestId) {
  let steering = null;
  const allowSteering = req.awfRequestContext?.purpose !== 'routing_classification';
  // A notice goes only on a request that ends with tool results, the kind a
  // working agent makes, so harness housekeeping requests (e.g. a request to
  // summarize the conversation) are skipped. Every conversation hears each
  // notice once, on its own next such request. Until a threshold of either
  // kind is crossed no notice can be selected, so the body is not inspected;
  // both guards are asked so each updates its crossed thresholds.
  const target = allowSteering && isSteeringEnabled() && (req.method === 'POST' || req.method === 'PUT') &&
    [hasCrossedTimeoutSteeringThreshold(), hasCrossedAiCreditSteeringThreshold()].includes(true)
    ? describeSteeringConversation(body, provider, req.url)
    : null;
  if (target?.endsWithToolResult) {
    const { conversation } = target;
    const steeringMessages = [
      {
        type: 'timeout',
        priority: 3,
        warning: getPendingTimeoutSteeringWarning(conversation),
        claim: claimTimeoutSteeringWarning,
      },
      {
        type: 'ai_credit',
        priority: 2,
        warning: getPendingAiCreditSteeringWarning(conversation),
        claim: claimAiCreditSteeringWarning,
      },
    ];
    // Ranks order notices: a threshold notice ranks as its percentage, the
    // "little left" notice just above the highest threshold crossed when it
    // fired (see littleLeftSteeringRank()).
    const nextWarning = steeringMessages
      .filter(candidate => candidate.warning)
      .sort((a, b) =>
        b.warning.rank - a.warning.rank || b.priority - a.priority
      )[0];
    if (nextWarning) {
      const steered = injectSteeringMessage(body, provider, nextWarning.warning.message, req.url);
      if (steered) {
        body = steered;
        // Records carry a 12-hex-character prefix of the opaque per-run
        // conversation key, or null in two cases: (a) a Responses request
        // that continues a stored response, which shares one entry and
        // receives each notice once per run; (b) an eligible request whose
        // opening cannot be keyed, which uses run-level state.
        const shortConversation = conversation && conversation !== STORED_RESPONSE_CONVERSATION
          ? conversation.slice(0, 12)
          : null;
        // `first` is set when this turns out to be the run's first delivery
        // of the notice; only that record of a threshold notice carries the
        // `steering` field. The "little left" notice has no threshold; its
        // delivery carries `steering` for the highest crossed threshold it
        // supersedes that is not yet recorded (`legacyThreshold`), if any.
        steering = {
          type: nextWarning.type,
          trigger: nextWarning.warning.trigger,
          threshold: nextWarning.warning.threshold,
          conversation: shortConversation,
          first: false,
        };
        // The notice stays pending until the request carrying it succeeds:
        // the upstream response handler acknowledges it on a 2xx response
        // and proxy-request releases it when the request fails. The
        // conversation is recorded as having heard it only on acknowledge.
        const delivery = nextWarning.claim(nextWarning.warning.rank, conversation);
        const steeringRecord = steering;
        req.awfSteeringDelivery = Object.freeze({
          acknowledge: () => {
            if (delivery.acknowledge()) steeringRecord.first = true;
            const legacyThreshold = delivery.legacyThreshold();
            if (legacyThreshold !== null) steeringRecord.legacyThreshold = legacyThreshold;
          },
          release: delivery.release,
        });
        logRequest('info', `${nextWarning.type}_steering`, {
          request_id: requestId,
          provider,
          trigger: nextWarning.warning.trigger,
          threshold: nextWarning.warning.threshold,
          conversation: shortConversation,
          message: nextWarning.warning.message,
        });
      }
    }
  }
  return { body, steering };
}

module.exports = { injectRequestSteering };
