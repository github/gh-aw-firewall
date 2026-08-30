const {
  LOCAL_AI_CREDITS_GUARD_EVENT,
  FINAL_EVENT_LOCAL_LIMIT,
  FINAL_EVENT_UPSTREAM_403,
  recordLocalGuardEvent,
  recordUpstreamStatus,
  getGuardResultSnapshot,
  resetGuardResultTrackerForTests,
} = require('./guard-result-tracker');
const { resetAiCreditsGuardForTests } = require('./ai-credits-guard');
const metrics = require('../metrics');

describe('guard-result-tracker', () => {
  beforeEach(() => {
    resetGuardResultTrackerForTests();
    resetAiCreditsGuardForTests();
    process.env.AWF_GUARD_RESULT_ENABLED = '1';
  });

  afterEach(() => {
    resetGuardResultTrackerForTests();
    resetAiCreditsGuardForTests();
    delete process.env.AWF_MAX_AI_CREDITS;
    delete process.env.AWF_GUARD_RESULT_ENABLED;
  });

  it('starts with zero counts and no final event', () => {
    const snapshot = getGuardResultSnapshot();
    expect(snapshot.local_ai_credits_limit_rejections).toBe(0);
    expect(snapshot.upstream_403_count).toBe(0);
    expect(snapshot.final_event).toBeNull();
    expect(snapshot.final_event_at).toBeNull();
    expect(snapshot.active_requests).toBe(0);
    expect(typeof snapshot.proxy_id).toBe('string');
    expect(snapshot.proxy_id.length).toBeGreaterThan(0);
  });

  it('reflects in-flight requests tracked by the shared metrics gauge', () => {
    metrics.gaugeInc('active_requests', { provider: 'openai' });
    try {
      expect(getGuardResultSnapshot().active_requests).toBe(1);
    } finally {
      metrics.gaugeDec('active_requests', { provider: 'openai' });
    }
    expect(getGuardResultSnapshot().active_requests).toBe(0);
  });

  it('generates a stable proxy_id across snapshots until reset', () => {
    const first = getGuardResultSnapshot().proxy_id;
    const second = getGuardResultSnapshot().proxy_id;
    expect(first).toBe(second);
    resetGuardResultTrackerForTests();
    const third = getGuardResultSnapshot().proxy_id;
    expect(third).not.toBe(first);
  });

  it('records local AI-credits-limit rejections and classifies the final event', () => {
    recordLocalGuardEvent(LOCAL_AI_CREDITS_GUARD_EVENT);
    recordLocalGuardEvent(LOCAL_AI_CREDITS_GUARD_EVENT);

    const snapshot = getGuardResultSnapshot();
    expect(snapshot.local_ai_credits_limit_rejections).toBe(2);
    expect(snapshot.final_event).toBe(FINAL_EVENT_LOCAL_LIMIT);
    expect(snapshot.final_event_at).toEqual(expect.any(Number));
  });

  it('ignores unrelated local guard events', () => {
    recordLocalGuardEvent('max_runs_exceeded');
    const snapshot = getGuardResultSnapshot();
    expect(snapshot.local_ai_credits_limit_rejections).toBe(0);
    expect(snapshot.final_event).toBeNull();
  });

  it('records upstream 403 responses and classifies the final event', () => {
    recordUpstreamStatus(403);
    const snapshot = getGuardResultSnapshot();
    expect(snapshot.upstream_403_count).toBe(1);
    expect(snapshot.final_event).toBe(FINAL_EVENT_UPSTREAM_403);
  });

  it('ignores non-403 upstream statuses', () => {
    recordUpstreamStatus(401);
    recordUpstreamStatus(500);
    const snapshot = getGuardResultSnapshot();
    expect(snapshot.upstream_403_count).toBe(0);
    expect(snapshot.final_event).toBeNull();
  });

  it('tracks the most recent event as final when both types occur', () => {
    recordLocalGuardEvent(LOCAL_AI_CREDITS_GUARD_EVENT);
    recordUpstreamStatus(403);
    expect(getGuardResultSnapshot().final_event).toBe(FINAL_EVENT_UPSTREAM_403);

    recordLocalGuardEvent(LOCAL_AI_CREDITS_GUARD_EVENT);
    expect(getGuardResultSnapshot().final_event).toBe(FINAL_EVENT_LOCAL_LIMIT);
  });

  it('reflects the configured AI-credits max and running total', () => {
    process.env.AWF_MAX_AI_CREDITS = '5';
    const snapshot = getGuardResultSnapshot();
    expect(snapshot.ai_credits_max).toBe(5);
    expect(snapshot.ai_credits_total).toBe(0);
  });

  it('reports a null ai_credits_max when no limit is configured', () => {
    const snapshot = getGuardResultSnapshot();
    expect(snapshot.ai_credits_max).toBeNull();
  });

  it('does not record events when the guard-result channel was not validated by the host', () => {
    delete process.env.AWF_GUARD_RESULT_ENABLED;
    recordLocalGuardEvent(LOCAL_AI_CREDITS_GUARD_EVENT);
    recordUpstreamStatus(403);
    const snapshot = getGuardResultSnapshot();
    expect(snapshot.local_ai_credits_limit_rejections).toBe(0);
    expect(snapshot.upstream_403_count).toBe(0);
    expect(snapshot.final_event).toBeNull();
  });
});
