'use strict';

/**
 * Adaptive selection: one deterministic choice per run from a workflow's evidence summary.
 *
 * gh-aw's prepare step summarizes the workflow's routing history (the evidence summary,
 * `v: 2`) and AWF passes it here with the router's full eligible rank. The selector keeps a
 * reliable incumbent, switches to a rival whose own record clears its need, probes a
 * suspended pair once another model has succeeded, and tests a promising rival within the
 * exploration the summary allows. It returns the selection receipt AWF records before the
 * primary starts. The function is pure: costs it has not measured come from `price`.
 *
 * The rule is the reference bandit's (gh-aw adaptive routing, plan v2); the oracle vectors
 * in fixtures/adaptive/fw2-selector.json pin every decision and reason.
 */

const PRICE = Object.freeze({ economy: 100, balanced: 500, robust: 2500 });
const PRIOR_WINS = 4.5;
const PRIOR_LOSSES = 0.5;
const CAP = 0.999;
const DECAY = 0.98;
const STREAK_NEW = 3;
const STREAK_PROVEN = 5;
const PROVEN_RUNS = 20;
const TEST_RUNS = 20;
const SHORTLIST = 3;
const CAPACITY_MAX = 3;
const MAX_SUMMARY_PAIRS = 32;
const MAX_SUMMARY_BYTES = 16 * 1024;

const ADAPTIVE_REASONS = Object.freeze([
  'summary_missing', 'invalid_evidence',
  'incumbent_chosen', 'incumbent_switched', 'no_challenger', 'all_suspended',
  'explore_denied', 'attempt_not_first', 'share_taken', 'no_turn',
  'probe_due', 'challenger_hopeful_clears_need',
]);

const PAIR_PATTERN = /^[^\s/@]+\/[^\s@]+@[^\s@]+$/;

/** The base model of a pair: everything before `@`. A suspension covers every effort of its base. */
function baseOf(pair) {
  return pair.slice(0, pair.lastIndexOf('@'));
}

/** Expected success rate, or the hopeful rate one standard deviation above it, capped at 0.999. */
function rate(wins, losses, hopeful) {
  const a = wins + PRIOR_WINS;
  const b = losses + PRIOR_LOSSES;
  const p = a / (a + b);
  return hopeful ? Math.min(CAP, p + Math.sqrt(p * (1 - p) / (a + b + 1))) : p;
}

/** Credits per successful run when each failure also costs `price`: (credits + price (1 - p)) / p. */
function score(credits, p, price) {
  return (credits + price * (1 - p)) / p;
}

const isCount = value => Number.isSafeInteger(value) && value >= 0;
const isAmount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function validTokens(tokens) {
  if (tokens === null) return true;
  return isRecord(tokens) && ['input', 'cache_read', 'cache_write', 'output'].every(key => isAmount(tokens[key])) &&
    (tokens.reasoning === null || isAmount(tokens.reasoning));
}

function validPair(entry) {
  return isRecord(entry) && typeof entry.pair === 'string' && PAIR_PATTERN.test(entry.pair) &&
    isAmount(entry.wins) && isAmount(entry.losses) && isCount(entry.runs) &&
    (entry.credits === null || isAmount(entry.credits)) &&
    (entry.model_credits === null || isAmount(entry.model_credits)) &&
    isCount(entry.bills) && validTokens(entry.tokens) && isCount(entry.streak) && isCount(entry.tests) &&
    (entry.suspended === null ||
      (isRecord(entry.suspended) && isCount(entry.suspended.pending) && typeof entry.suspended.probe_due === 'boolean'));
}

/**
 * Whether a summary is usable for this job: the known version and bounds, and the workflow, run
 * ID and attempt of the job AWF itself runs in.
 */
function validSummary(summary, job) {
  if (!isRecord(summary) || summary.v !== 2) return false;
  if (summary.workflow !== job.workflow || !isRecord(summary.run) ||
      summary.run.id !== job.run_id || summary.run.attempt !== job.attempt) return false;
  if (!['live', 'observe'].includes(summary.mode) || !Object.hasOwn(PRICE, summary.level)) return false;
  if (typeof summary.generation !== 'string' || typeof summary.scope !== 'string') return false;
  if (summary.incumbent !== null && (typeof summary.incumbent !== 'string' || !PAIR_PATTERN.test(summary.incumbent))) {
    return false;
  }
  const explore = summary.explore;
  if (!isRecord(explore) || typeof explore.allowed !== 'boolean' || typeof explore.share !== 'boolean' ||
      typeof explore.turn !== 'boolean' || !isCount(explore.in_flight)) return false;
  if (!Array.isArray(summary.pairs) || summary.pairs.length > MAX_SUMMARY_PAIRS || !summary.pairs.every(validPair)) {
    return false;
  }
  if (new Set(summary.pairs.map(entry => entry.pair)).size !== summary.pairs.length) return false;
  return Buffer.byteLength(JSON.stringify(summary), 'utf8') <= MAX_SUMMARY_BYTES;
}

/**
 * The largest n from 1 to 3 for which, with n - 1 failures appended as the rival's newest
 * outcomes, its hopeful score still beats the incumbent's, the assumed failures would not
 * suspend it, and its 20-test allowance lasts. Earlier runs that may be testing count as those
 * failures, so a broken rival fails no more runs than it would if runs took turns.
 */
function capacity(entry, credits, incumbentHope, price) {
  const wins = entry ? entry.wins : 0;
  const losses = entry ? entry.losses : 0;
  const streak = entry ? entry.streak : 0;
  const tests = entry ? entry.tests : 0;
  const runs = entry ? entry.runs : 0;
  let room = 0;
  for (let n = 1; n <= CAPACITY_MAX; n += 1) {
    const assumed = n - 1;
    let w = wins;
    let l = losses;
    for (let i = 0; i < assumed; i += 1) {
      w *= DECAY;
      l = l * DECAY + 1;
    }
    if (!(score(credits, rate(w, l, true), price) < incumbentHope)) break;
    if (!(streak + assumed < (runs + assumed <= PROVEN_RUNS ? STREAK_NEW : STREAK_PROVEN))) break;
    if (!(tests + assumed < TEST_RUNS)) break;
    room = n;
  }
  return room;
}

function compareKeys(left, right) {
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] < right[i]) return -1;
    if (left[i] > right[i]) return 1;
  }
  return 0;
}

function argmin(items, keyOf) {
  let best;
  let bestKey;
  for (const item of items) {
    const itemKey = keyOf(item);
    if (best === undefined || compareKeys(itemKey, bestKey) < 0) {
      best = item;
      bestKey = itemKey;
    }
  }
  return best;
}

function stringOrNull(value) {
  return typeof value === 'string' ? value : null;
}

/**
 * Decide one run's primary pair and its selection receipt.
 *
 * @param {object} input
 * @param {object|null|undefined} input.summary The evidence summary, or null when none was found.
 * @param {string[]} input.rank The router's full eligible rank of pairs, best first.
 * @param {string} [input.ordinary] The ordinary pick; defaults to the first ranked pair.
 * @param {{ workflow: string, run_id: string, attempt: number }} input.job AWF's own job.
 * @param {(pair: string, tokens: object) => number|null} input.price Credits for the given average
 *   tokens at the pair's own tariff, or null when the pair has no tariff of its own.
 * @returns {object} The selection receipt.
 */
function selectAdaptive({ summary, rank, ordinary = rank[0], job, price }) {
  const receipt = {
    event: 'adaptive_selection',
    v: 2,
    workflow: job.workflow,
    run: { id: job.run_id, attempt: job.attempt },
  };
  if (summary === null || summary === undefined || !validSummary(summary, job)) {
    const echo = isRecord(summary) ? summary : {};
    return Object.assign(receipt, {
      generation: stringOrNull(echo.generation),
      mode: stringOrNull(echo.mode),
      scope: stringOrNull(echo.scope),
      role: 'ordinary',
      explore_allowed: false,
      selected: ordinary,
      ordinary,
      would: null,
      incumbent: null,
      costs: {},
      concurrency: null,
      reason: summary === null || summary === undefined ? 'summary_missing' : 'invalid_evidence',
    });
  }

  const { mode, explore } = summary;
  const failurePrice = PRICE[summary.level];
  const records = new Map(summary.pairs.map(entry => [entry.pair, entry]));
  const order = new Map(rank.map((pair, index) => [pair, index]));
  const blocked = new Set(summary.pairs.filter(entry => entry.suspended !== null).map(entry => baseOf(entry.pair)));
  const usable = rank.filter(pair => !blocked.has(baseOf(pair)));
  const position = new Map(usable.map((pair, index) => [pair, index]));
  const incumbentBefore = summary.incumbent;
  const allowed = explore.allowed === true && job.attempt === 1;
  const concurrency = { turn: explore.turn, in_flight: explore.in_flight, capacity: null };
  Object.assign(receipt, {
    generation: summary.generation,
    mode,
    scope: summary.scope,
    explore_allowed: allowed,
  });

  const runsOf = pair => records.get(pair)?.runs ?? 0;
  const ratesOf = pair => {
    const entry = records.get(pair);
    const wins = entry ? entry.wins : 0;
    const losses = entry ? entry.losses : 0;
    return [rate(wins, losses, false), rate(wins, losses, true)];
  };
  const keyOf = (pair, credits, hopeful) =>
    [score(credits, ratesOf(pair)[hopeful ? 1 : 0], failurePrice), position.get(pair) ?? position.size, pair];

  const finish = (role, selected, reason, incumbentAfter, costs) => {
    if (mode === 'observe') {
      Object.assign(receipt, {
        role: 'observe', selected: ordinary, ordinary, would: selected,
        incumbent: { before: incumbentBefore, after: incumbentBefore },
      });
    } else {
      Object.assign(receipt, {
        role, selected, ordinary, would: null,
        incumbent: { before: incumbentBefore, after: incumbentAfter },
      });
    }
    const costRecord = {};
    for (const [pair, [credits, basis]] of costs) costRecord[pair] = { credits, basis };
    return Object.assign(receipt, { costs: costRecord, concurrency, reason });
  };

  if (usable.length === 0) {
    let pick = ordinary;
    let best;
    for (const pair of rank) {
      if (!records.has(pair)) continue;
      const expected = ratesOf(pair)[0];
      if (best === undefined || expected > best) {
        best = expected;
        pick = pair;
      }
    }
    return finish('serve', pick, 'all_suspended', incumbentBefore, new Map());
  }

  const measured = pair => {
    const credits = records.get(pair)?.credits;
    return credits === null || credits === undefined ? null : [credits, 'measured'];
  };
  // A pair without a measured cost is priced from the incumbent's own tokens at the pair's
  // tariff; only the incumbent model's share of the cost is repriced.
  const costWith = (pair, incumbent) => {
    const known = measured(pair);
    if (known) return known;
    const incumbentRecord = incumbent ? records.get(incumbent) : undefined;
    if (!incumbentRecord || incumbentRecord.tokens === null) return null;
    const pairPrice = price(pair, incumbentRecord.tokens);
    const incumbentPrice = price(incumbent, incumbentRecord.tokens);
    if (!isAmount(pairPrice) || !isAmount(incumbentPrice) || incumbentPrice === 0) return null;
    const incumbentCost = measured(incumbent);
    if (!incumbentCost) return [pairPrice, 'estimated'];
    const modelCredits = incumbentRecord.model_credits ?? incumbentCost[0];
    if (modelCredits > incumbentCost[0]) return null;
    const estimate = incumbentCost[0] + modelCredits * (pairPrice / incumbentPrice - 1);
    if (!Number.isFinite(estimate) || estimate < 0) return null;
    return [estimate, 'estimated'];
  };

  let incumbent = usable.includes(incumbentBefore) ? incumbentBefore : null;
  if (incumbent === null) {
    const succeeded = usable.filter(pair => records.has(pair) && records.get(pair).wins > 0);
    const priced = succeeded.filter(pair => measured(pair));
    incumbent = priced.length > 0
      ? argmin(priced, pair => keyOf(pair, measured(pair)[0], false))
      : (succeeded[0] ?? usable[0]);
  }

  let switched = false;
  const costs = new Map();
  let incumbentCost = costWith(incumbent, incumbent);
  if (incumbentCost) {
    costs.set(incumbent, incumbentCost);
    const tried = new Map();
    for (const pair of usable) {
      if (pair === incumbent || runsOf(pair) === 0) continue;
      const cost = costWith(pair, incumbent);
      if (cost) tried.set(pair, cost);
    }
    for (const [pair, cost] of tried) costs.set(pair, cost);
    if (tried.size > 0) {
      const best = argmin(tried.keys(), pair => keyOf(pair, tried.get(pair)[0], false));
      if (keyOf(best, tried.get(best)[0], false)[0] < keyOf(incumbent, incumbentCost[0], true)[0]) {
        incumbent = best;
        switched = true;
        // A pair that won on an estimate but cannot price itself keeps the estimate it won with.
        incumbentCost = costWith(incumbent, incumbent) ?? tried.get(best);
        costs.set(incumbent, incumbentCost);
      }
    }
  }

  const dueEntries = summary.pairs.filter(entry => entry.suspended?.probe_due);
  const exactDueBases = new Set(
    dueEntries.filter(entry => order.has(entry.pair)).map(entry => baseOf(entry.pair)),
  );
  const dueTargets = new Set();
  for (const entry of dueEntries) {
    let target = null;
    if (order.has(entry.pair)) {
      target = entry.pair;
    } else if (!exactDueBases.has(baseOf(entry.pair))) {
      target = rank.find(pair => baseOf(pair) === baseOf(entry.pair)) ?? null;
    }
    if (target !== null) dueTargets.add(target);
  }
  const due = [...dueTargets].sort((left, right) => order.get(left) - order.get(right));
  let want = null;
  let room = 0;
  if (due.length > 0) {
    want = ['probe', due[0]];
    room = 1;
  } else if (incumbentCost) {
    const seen = new Set();
    const shortlist = [];
    for (const pair of usable) {
      if (shortlist.length === SHORTLIST) break;
      if (seen.has(baseOf(pair))) continue;
      seen.add(baseOf(pair));
      shortlist.push(pair);
    }
    const rivals = new Map();
    for (const pair of shortlist) {
      if (pair === incumbent || (records.get(pair)?.tests ?? 0) >= TEST_RUNS) continue;
      const cost = costWith(pair, incumbent);
      if (cost) rivals.set(pair, cost);
    }
    for (const [pair, cost] of rivals) costs.set(pair, cost);
    if (rivals.size > 0) {
      const challenger = argmin(rivals.keys(), pair => keyOf(pair, rivals.get(pair)[0], true));
      const incumbentHope = keyOf(incumbent, incumbentCost[0], true)[0];
      if (keyOf(challenger, rivals.get(challenger)[0], true)[0] < incumbentHope) {
        want = ['test', challenger];
        room = capacity(records.get(challenger), rivals.get(challenger)[0], incumbentHope, failurePrice);
      }
    }
  }

  if (want === null) {
    const reason = switched ? 'incumbent_switched' : incumbent !== incumbentBefore ? 'incumbent_chosen' : 'no_challenger';
    return finish('serve', incumbent, reason, incumbent, costs);
  }
  const [kind, target] = want;
  concurrency.capacity = room;
  // Observe mode reports what live mode would run, so its denial counts as permission here.
  const permitted = allowed || (mode === 'observe' && explore.reason === 'observe' && job.attempt === 1);
  let blockedReason = null;
  if (!permitted) blockedReason = job.attempt === 1 ? 'explore_denied' : 'attempt_not_first';
  else if (!explore.share) blockedReason = 'share_taken';
  else if (!(explore.turn && explore.in_flight < room)) blockedReason = 'no_turn';
  if (blockedReason !== null) return finish('serve', incumbent, blockedReason, incumbent, costs);
  if (kind === 'probe') return finish('probe', target, 'probe_due', incumbent, costs);
  return finish('test', target, 'challenger_hopeful_clears_need', incumbent, costs);
}

module.exports = {
  ADAPTIVE_REASONS,
  MAX_SUMMARY_BYTES,
  PRICE,
  baseOf,
  capacity,
  rate,
  score,
  selectAdaptive,
  validSummary,
};
