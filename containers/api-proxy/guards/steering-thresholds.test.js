const {
  MAX_STEERING_CONVERSATIONS,
  createSteeringDeliveryState,
  selectSteeringThreshold,
  claimSteeringThreshold,
} = require('./steering-thresholds');

describe('per-conversation steering delivery', () => {
  test('keeps the in-flight check per conversation', () => {
    const delivery = createSteeringDeliveryState();
    const crossed = new Set([80]);
    delivery.pending.add(80);

    const a = claimSteeringThreshold(delivery, selectSteeringThreshold(delivery, crossed, 'a'), 'a');
    expect(selectSteeringThreshold(delivery, crossed, 'a')).toBeNull();
    expect(selectSteeringThreshold(delivery, crossed, 'b')).toBe(80);
    a.release();
    expect(selectSteeringThreshold(delivery, crossed, 'a')).toBe(80);
    expect(delivery.conversations.size).toBe(0);
    expect(delivery.conversationInFlight.size).toBe(0);
  });

  test('records a conversation on acknowledge and reports the run-level first delivery once', () => {
    const delivery = createSteeringDeliveryState();
    const crossed = new Set([80, 90]);
    delivery.pending.add(80).add(90);

    const a = claimSteeringThreshold(delivery, 90, 'a');
    const b = claimSteeringThreshold(delivery, 90, 'b');
    expect(b.acknowledge()).toBe(true);
    expect(a.acknowledge()).toBe(false);
    expect(a.acknowledge()).toBe(false);
    expect(selectSteeringThreshold(delivery, crossed, 'a')).toBeNull();
    expect(selectSteeringThreshold(delivery, crossed, 'b')).toBeNull();
    expect(selectSteeringThreshold(delivery, crossed, 'c')).toBe(90);
    // Run-level requests (no conversation) get each notice once per run.
    expect(selectSteeringThreshold(delivery, crossed, null)).toBeNull();
  });

  test('bounds the table by dropping the conversation notified least recently', () => {
    const delivery = createSteeringDeliveryState();
    const crossed = new Set([80]);
    for (let i = 0; i <= MAX_STEERING_CONVERSATIONS; i += 1) {
      claimSteeringThreshold(delivery, 80, `conversation-${i}`).acknowledge();
    }
    expect(delivery.conversations.size).toBe(MAX_STEERING_CONVERSATIONS);
    expect(selectSteeringThreshold(delivery, crossed, 'conversation-0')).toBe(80);
    expect(selectSteeringThreshold(delivery, crossed, `conversation-${MAX_STEERING_CONVERSATIONS}`)).toBeNull();
  });
});
