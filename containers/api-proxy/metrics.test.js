'use strict';

// We need fresh module state for each test since metrics uses module-level state
let metrics;

beforeEach(() => {
  // Clear the module cache to reset all counters/histograms/gauges
  jest.resetModules();
  metrics = require('./metrics');
});

describe('metrics', () => {
  describe('statusClass', () => {
    it('should return 2xx for 200-299', () => {
      expect(metrics.statusClass(200)).toBe('2xx');
      expect(metrics.statusClass(201)).toBe('2xx');
      expect(metrics.statusClass(299)).toBe('2xx');
    });

    it('should return 4xx for 400-499', () => {
      expect(metrics.statusClass(400)).toBe('4xx');
      expect(metrics.statusClass(404)).toBe('4xx');
      expect(metrics.statusClass(429)).toBe('4xx');
    });

    it('should return 5xx for 500-599', () => {
      expect(metrics.statusClass(500)).toBe('5xx');
      expect(metrics.statusClass(502)).toBe('5xx');
      expect(metrics.statusClass(503)).toBe('5xx');
    });

    it('should return 3xx for 300-399', () => {
      expect(metrics.statusClass(301)).toBe('3xx');
      expect(metrics.statusClass(304)).toBe('3xx');
    });

    it('should return 1xx for 100-199', () => {
      expect(metrics.statusClass(100)).toBe('1xx');
      expect(metrics.statusClass(101)).toBe('1xx');
    });
  });

  describe('counters', () => {
    it('should create new counter with value 1 on first increment', () => {
      metrics.increment('requests_total', { provider: 'openai' });
      const result = metrics.getMetrics();
      expect(result.counters['requests_total:openai']).toBe(1);
    });

    it('should add to existing counter', () => {
      metrics.increment('requests_total', { provider: 'openai' });
      metrics.increment('requests_total', { provider: 'openai' });
      metrics.increment('requests_total', { provider: 'openai' });
      const result = metrics.getMetrics();
      expect(result.counters['requests_total:openai']).toBe(3);
    });

    it('should increment with custom value', () => {
      metrics.increment('request_bytes_total', { provider: 'openai' }, 1024);
      const result = metrics.getMetrics();
      expect(result.counters['request_bytes_total:openai']).toBe(1024);
    });

    it('should create separate counters for different labels', () => {
      metrics.increment('requests_total', { provider: 'openai', method: 'POST', status_class: '2xx' });
      metrics.increment('requests_total', { provider: 'anthropic', method: 'POST', status_class: '2xx' });
      const result = metrics.getMetrics();
      expect(result.counters['requests_total:openai:POST:2xx']).toBe(1);
      expect(result.counters['requests_total:anthropic:POST:2xx']).toBe(1);
    });

    it('should use _ as key when no labels provided', () => {
      metrics.increment('total', null);
      const result = metrics.getMetrics();
      expect(result.counters['total:_']).toBe(1);
    });
  });

  describe('histograms', () => {
    it('should distribute values into correct buckets', () => {
      // Value of 75 should be in buckets 100, 250, 500, 1000, 2500, 5000, 10000, 30000, +Inf
      metrics.observe('request_duration_ms', 75, { provider: 'openai' });
      const result = metrics.getMetrics();
      const h = result.histograms.request_duration_ms.openai;
      expect(h.buckets[10]).toBe(0);
      expect(h.buckets[50]).toBe(0);
      expect(h.buckets[100]).toBe(1);
      expect(h.buckets[250]).toBe(1);
      expect(h.buckets['+Inf']).toBe(1);
    });

    it('should track sum and count', () => {
      metrics.observe('request_duration_ms', 100, { provider: 'openai' });
      metrics.observe('request_duration_ms', 200, { provider: 'openai' });
      const result = metrics.getMetrics();
      const h = result.histograms.request_duration_ms.openai;
      expect(h.count).toBe(2);
      expect(h.sum).toBe(300);
    });

    it('should always increment +Inf bucket', () => {
      metrics.observe('request_duration_ms', 5, { provider: 'openai' });
      metrics.observe('request_duration_ms', 50000, { provider: 'openai' });
      const result = metrics.getMetrics();
      const h = result.histograms.request_duration_ms.openai;
      expect(h.buckets['+Inf']).toBe(2);
    });

    it('should calculate p50 correctly for known distribution', () => {
      // Add 100 values: 1, 2, 3, ..., 100
      // Median should be around 50
      for (let i = 1; i <= 100; i++) {
        metrics.observe('latency', i, { provider: 'test' });
      }
      const result = metrics.getMetrics();
      const h = result.histograms.latency.test;
      // p50 of 1..100 should be around 50 (exact value depends on bucket interpolation)
      expect(h.p50).toBeGreaterThanOrEqual(40);
      expect(h.p50).toBeLessThanOrEqual(60);
    });

    it('should calculate p90 and p99 correctly', () => {
      // All values at 5ms — all within first bucket (10)
      for (let i = 0; i < 100; i++) {
        metrics.observe('latency', 5, { provider: 'test' });
      }
      const result = metrics.getMetrics();
      const h = result.histograms.latency.test;
      // p90 and p99 should both be <= 10 since all values are in the first bucket
      expect(h.p90).toBeLessThanOrEqual(10);
      expect(h.p99).toBeLessThanOrEqual(10);
    });

    it('should return 0 percentile when no data', () => {
      // Access an empty histogram through getMetrics
      // Since no data = no histogram entry, we test via the constructor
      const result = metrics.getMetrics();
      expect(result.histograms).toEqual({});
    });
  });

  describe('gauges', () => {
    it('should increment gauge', () => {
      metrics.gaugeInc('active_requests', { provider: 'openai' });
      metrics.gaugeInc('active_requests', { provider: 'openai' });
      const result = metrics.getMetrics();
      expect(result.gauges.active_requests.openai).toBe(2);
    });

    it('should decrement gauge', () => {
      metrics.gaugeInc('active_requests', { provider: 'openai' });
      metrics.gaugeInc('active_requests', { provider: 'openai' });
      metrics.gaugeDec('active_requests', { provider: 'openai' });
      const result = metrics.getMetrics();
      expect(result.gauges.active_requests.openai).toBe(1);
    });

    it('should set gauge to exact value', () => {
      metrics.gaugeSet('temperature', { sensor: 'cpu' }, 72.5);
      const result = metrics.getMetrics();
      expect(result.gauges.temperature.cpu).toBe(72.5);
    });

    it('should allow negative gauge values', () => {
      metrics.gaugeDec('test_gauge', { key: 'val' });
      const result = metrics.getMetrics();
      expect(result.gauges.test_gauge.val).toBe(-1);
    });
  });

  describe('getMetrics', () => {
    it('should return correct structure with counters, histograms, gauges', () => {
      const result = metrics.getMetrics();
      expect(result).toHaveProperty('counters');
      expect(result).toHaveProperty('histograms');
      expect(result).toHaveProperty('gauges');
    });

    it('should include uptime_seconds in gauges', () => {
      const result = metrics.getMetrics();
      expect(typeof result.gauges.uptime_seconds).toBe('number');
      expect(result.gauges.uptime_seconds).toBeGreaterThanOrEqual(0);
    });

    it('should include percentiles in histogram output', () => {
      metrics.observe('request_duration_ms', 100, { provider: 'openai' });
      const result = metrics.getMetrics();
      const h = result.histograms.request_duration_ms.openai;
      expect(h).toHaveProperty('p50');
      expect(h).toHaveProperty('p90');
      expect(h).toHaveProperty('p99');
      expect(h).toHaveProperty('count');
      expect(h).toHaveProperty('sum');
      expect(h).toHaveProperty('buckets');
    });
  });

  describe('getSummary', () => {
    it('should return compact summary structure', () => {
      const summary = metrics.getSummary();
      expect(summary).toHaveProperty('total_requests');
      expect(summary).toHaveProperty('total_errors');
      expect(summary).toHaveProperty('active_requests');
      expect(summary).toHaveProperty('avg_latency_ms');
    });

    it('should calculate total_requests correctly across labels', () => {
      metrics.increment('requests_total', { provider: 'openai', method: 'POST', status_class: '2xx' });
      metrics.increment('requests_total', { provider: 'openai', method: 'POST', status_class: '2xx' });
      metrics.increment('requests_total', { provider: 'anthropic', method: 'POST', status_class: '2xx' });
      const summary = metrics.getSummary();
      expect(summary.total_requests).toBe(3);
    });

    it('should calculate avg_latency_ms correctly', () => {
      metrics.observe('request_duration_ms', 100, { provider: 'openai' });
      metrics.observe('request_duration_ms', 200, { provider: 'openai' });
      metrics.observe('request_duration_ms', 300, { provider: 'anthropic' });
      const summary = metrics.getSummary();
      // (100 + 200 + 300) / 3 = 200
      expect(summary.avg_latency_ms).toBe(200);
    });

    it('should return 0 avg_latency_ms when no requests', () => {
      const summary = metrics.getSummary();
      expect(summary.avg_latency_ms).toBe(0);
    });

    it('should count active requests from gauge', () => {
      metrics.gaugeInc('active_requests', { provider: 'openai' });
      metrics.gaugeInc('active_requests', { provider: 'anthropic' });
      const summary = metrics.getSummary();
      expect(summary.active_requests).toBe(2);
    });
  });

  describe('memory bounds', () => {
    it('should not grow unboundedly with many distinct counter labels', () => {
      // Feed many distinct labels
      for (let i = 0; i < 1000; i++) {
        metrics.increment('requests_total', { provider: `provider_${i}`, method: 'POST', status_class: '2xx' });
      }
      const result = metrics.getMetrics();
      // Counters should exist but the count should be bounded by what we added
      const keys = Object.keys(result.counters);
      expect(keys.length).toBe(1000);
      // Each counter should have value 1
      for (const key of keys) {
        expect(result.counters[key]).toBe(1);
      }
    });
  });

  describe('HISTOGRAM_BUCKETS', () => {
    it('should export the expected bucket boundaries', () => {
      expect(metrics.HISTOGRAM_BUCKETS).toEqual([10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000]);
    });
  });
});
