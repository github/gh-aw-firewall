'use strict';

const {
  createWindow,
  advanceWindow,
  recordInWindow,
  getWindowCount,
  estimateRetryAfter,
} = require('./rate-limiter-window');

const SIZE = 10; // Small window size for easier testing

describe('rate-limiter-window', () => {
  describe('createWindow', () => {
    it('should create a window with all-zero counts', () => {
      const win = createWindow(SIZE);
      expect(win.counts).toHaveLength(SIZE);
      expect(win.counts.every((c) => c === 0)).toBe(true);
    });

    it('should initialize total to 0', () => {
      const win = createWindow(SIZE);
      expect(win.total).toBe(0);
    });

    it('should initialize lastSlot to -1 (uninitialized)', () => {
      const win = createWindow(SIZE);
      expect(win.lastSlot).toBe(-1);
    });

    it('should create independent windows for different sizes', () => {
      const w5 = createWindow(5);
      const w20 = createWindow(20);
      expect(w5.counts).toHaveLength(5);
      expect(w20.counts).toHaveLength(20);
    });
  });

  describe('advanceWindow', () => {
    it('should initialize lastSlot on first use', () => {
      const win = createWindow(SIZE);
      advanceWindow(win, 100, SIZE);
      expect(win.lastSlot).toBe(100 % SIZE);
      expect(win.lastTime).toBe(100);
    });

    it('should be a no-op if called twice at the same time', () => {
      const win = createWindow(SIZE);
      advanceWindow(win, 100, SIZE);
      recordInWindow(win, 100, SIZE, 5);
      advanceWindow(win, 100, SIZE); // same time
      expect(win.total).toBe(5);
    });

    it('should zero stale slots when time advances by 1', () => {
      const win = createWindow(SIZE);
      recordInWindow(win, 100, SIZE, 3); // slot 0 (100 % 10)
      recordInWindow(win, 101, SIZE, 4); // slot 1
      advanceWindow(win, 111, SIZE);     // advances 10 slots — clears slot 1 but not freshly written ones
      // After advancing 10 slots from t=101, all slots from 102..111 are zeroed.
      // slot 1 (t=101) is within slotsToZero (10), so it gets zeroed.
      // slot 0 (t=100) also gets zeroed via full-window reset path.
      expect(win.total).toBe(0);
    });

    it('should zero all slots when full window expires', () => {
      const win = createWindow(SIZE);
      recordInWindow(win, 0, SIZE, 7);
      advanceWindow(win, SIZE, SIZE); // elapsed == SIZE → full reset
      expect(win.total).toBe(0);
      expect(win.counts.every((c) => c === 0)).toBe(true);
    });

    it('should not allow total to go negative on partial advance', () => {
      const win = createWindow(SIZE);
      recordInWindow(win, 10, SIZE, 5);
      recordInWindow(win, 11, SIZE, 3);
      // Advance by 1: slot at t=10 stays, slot at t=11 becomes current
      // Advance by 2: slot 0 (t=10) is zeroed
      advanceWindow(win, 12, SIZE);
      expect(win.total).toBeGreaterThanOrEqual(0);
    });

    it('should handle clock going backwards gracefully', () => {
      const win = createWindow(SIZE);
      recordInWindow(win, 100, SIZE, 5);
      advanceWindow(win, 99, SIZE); // backwards — should be a no-op
      expect(win.total).toBe(5);
    });
  });

  describe('recordInWindow', () => {
    it('should increment total by the recorded value', () => {
      const win = createWindow(SIZE);
      recordInWindow(win, 0, SIZE, 1);
      expect(win.total).toBe(1);
      recordInWindow(win, 0, SIZE, 4);
      expect(win.total).toBe(5);
    });

    it('should store value in the correct slot', () => {
      const win = createWindow(SIZE);
      const now = 7;
      recordInWindow(win, now, SIZE, 9);
      expect(win.counts[now % SIZE]).toBe(9);
    });

    it('should accumulate multiple records in the same slot', () => {
      const win = createWindow(SIZE);
      recordInWindow(win, 5, SIZE, 2);
      recordInWindow(win, 5, SIZE, 3);
      expect(win.counts[5 % SIZE]).toBe(5);
      expect(win.total).toBe(5);
    });

    it('should wrap-around correctly when now exceeds SIZE', () => {
      const win = createWindow(SIZE);
      recordInWindow(win, 0, SIZE, 1);   // slot 0
      recordInWindow(win, SIZE, SIZE, 2); // slot 0 again (wrap), but t=10 so slot 0 gets zeroed first
      expect(win.total).toBe(2); // old slot 0 was cleared, new value is 2
    });
  });

  describe('getWindowCount', () => {
    it('should return 0 for an empty window', () => {
      const win = createWindow(SIZE);
      expect(getWindowCount(win, 0, SIZE)).toBe(0);
    });

    it('should return the total count of active events', () => {
      const win = createWindow(SIZE);
      recordInWindow(win, 0, SIZE, 3);
      recordInWindow(win, 1, SIZE, 2);
      expect(getWindowCount(win, 1, SIZE)).toBe(5);
    });

    it('should exclude expired slots', () => {
      const win = createWindow(SIZE);
      recordInWindow(win, 0, SIZE, 7);
      // Advance past full window
      const count = getWindowCount(win, SIZE + 1, SIZE);
      expect(count).toBe(0);
    });

    it('should count events recorded across multiple slots', () => {
      const win = createWindow(SIZE);
      for (let t = 0; t < SIZE; t++) {
        recordInWindow(win, t, SIZE, 1);
      }
      expect(getWindowCount(win, SIZE - 1, SIZE)).toBe(SIZE);
    });
  });

  describe('estimateRetryAfter', () => {
    it('should return at least 1', () => {
      const win = createWindow(SIZE);
      recordInWindow(win, 0, SIZE, 5);
      advanceWindow(win, 0, SIZE);
      expect(estimateRetryAfter(win, 0, SIZE, 5)).toBeGreaterThanOrEqual(1);
    });

    it('should return SIZE when count must drop to 0', () => {
      const win = createWindow(SIZE);
      // Fill the entire window evenly
      for (let t = 0; t < SIZE; t++) {
        recordInWindow(win, t, SIZE, 1);
      }
      // To drop below 1, every slot must expire (newest expires last)
      const retry = estimateRetryAfter(win, SIZE - 1, SIZE, 1);
      expect(retry).toBe(SIZE);
    });

    it('should return SIZE when only the current slot is occupied', () => {
      const win = createWindow(SIZE);
      // Record only in the most recent slot
      recordInWindow(win, SIZE - 1, SIZE, 5);
      const retry = estimateRetryAfter(win, SIZE - 1, SIZE, 5);
      expect(retry).toBe(SIZE); // newest slot expires in SIZE time-units
    });

    it('should find the slot that frees enough capacity', () => {
      const win = createWindow(SIZE);
      recordInWindow(win, 0, SIZE, 3); // older slot (age=1 at now=1)
      recordInWindow(win, 1, SIZE, 2); // current slot
      advanceWindow(win, 1, SIZE);
      // total=5, limit=5: need to drop below 5, so the older slot must expire
      const retry = estimateRetryAfter(win, 1, SIZE, 5);
      expect(retry).toBe(SIZE - 1);
    });
  });
});
