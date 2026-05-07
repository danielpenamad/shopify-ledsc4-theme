// Token bucket rate limiter + worker pool for the import writer.
//
// Two abstractions:
//   - createTokenBucket({ capacity, refillPerSec }) → { acquire(n=1) }
//     A classic token bucket. Burst up to `capacity`, refill at
//     `refillPerSec`. acquire(n) returns a Promise that resolves once
//     `n` tokens are available. Tokens accrue continuously, not in
//     discrete ticks.
//   - runWithConcurrency({ items, concurrency, work }) → array of results
//     A simple worker pool. Spawns up to `concurrency` workers that each
//     pull from `items` and run `work(item)` until the queue is drained.
//     Returns the per-item results in original order. Worker errors are
//     captured into the result entry as { error } — they do NOT abort
//     the whole pool. The caller decides what to do with errors.
//
// Together: each worker calls `bucket.acquire()` before each Shopify
// mutation. With concurrency=4 and a bucket of capacity=50 / refill=2/sec,
// the first ~50 calls go through immediately (burst), then the workers
// settle into ~2 mut/sec aggregate (rate-limited regardless of how many
// workers are idle).
//
// Backoff on 429 / THROTTLED is the CALLER's responsibility — the bucket
// just enforces the local rate. The runFullImport orchestrator wraps each
// API call with a try/catch and pauses ALL workers (via bucket.pause(ms))
// when Shopify says retry-after.

// Note: Pure ESM, zero dependencies. Works in Node 18+ and Deno via
// node:* compat (no node:* imports needed here — pure JS + Promise).

export function createTokenBucket({ capacity, refillPerSec }) {
  if (!(capacity > 0)) throw new Error('capacity must be > 0');
  if (!(refillPerSec > 0)) throw new Error('refillPerSec must be > 0');

  let tokens = capacity;
  let lastRefillTs = Date.now();
  // FIFO queue of waiters. Each entry: { n, resolve }.
  const waiters = [];
  // Pause until this timestamp (ms epoch). 0 means not paused.
  let pausedUntil = 0;

  function refill() {
    const now = Date.now();
    const dt = (now - lastRefillTs) / 1000;
    if (dt > 0) {
      tokens = Math.min(capacity, tokens + dt * refillPerSec);
      lastRefillTs = now;
    }
  }

  function tryDrainWaiters() {
    // Process waiters in order. If the head can't be served (not enough
    // tokens or paused), schedule a re-check; later waiters are still
    // blocked behind the head to preserve FIFO fairness.
    while (waiters.length > 0) {
      refill();
      const now = Date.now();
      if (pausedUntil > now) {
        // Wait until pause ends, then retry.
        setTimeout(tryDrainWaiters, pausedUntil - now);
        return;
      }
      const head = waiters[0];
      if (tokens >= head.n) {
        tokens -= head.n;
        waiters.shift();
        head.resolve();
      } else {
        // Not enough tokens for the head waiter. Sleep until we'd have
        // enough, then retry.
        const need = head.n - tokens;
        const waitMs = Math.ceil((need / refillPerSec) * 1000);
        setTimeout(tryDrainWaiters, Math.max(waitMs, 5));
        return;
      }
    }
  }

  return {
    acquire(n = 1) {
      if (!(n > 0)) throw new Error('acquire(n): n must be > 0');
      refill();
      const now = Date.now();
      if (waiters.length === 0 && pausedUntil <= now && tokens >= n) {
        tokens -= n;
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        waiters.push({ n, resolve });
        tryDrainWaiters();
      });
    },
    // Pause the bucket for `ms` from now. New and pending acquires will
    // wait until the pause expires before being considered. Used on 429.
    pause(ms) {
      if (!(ms > 0)) return;
      pausedUntil = Math.max(pausedUntil, Date.now() + ms);
      tryDrainWaiters();
    },
    // Diagnostics, mainly for tests.
    _state() {
      refill();
      return { tokens, waiters: waiters.length, pausedUntil };
    },
  };
}

// Lightweight worker pool. items can be any array; work(item, index) is an
// async function. Up to `concurrency` work() invocations run at once. The
// returned array preserves the original order. Errors are captured per item.
export async function runWithConcurrency({ items, concurrency, work }) {
  if (!Array.isArray(items)) throw new Error('items must be an array');
  if (!(concurrency > 0)) throw new Error('concurrency must be > 0');

  const results = new Array(items.length);
  let nextIdx = 0;

  async function worker() {
    while (true) {
      const i = nextIdx++;
      if (i >= items.length) return;
      try {
        results[i] = { ok: true, value: await work(items[i], i) };
      } catch (err) {
        results[i] = { ok: false, error: err };
      }
    }
  }

  const n = Math.min(concurrency, items.length);
  const workers = [];
  for (let i = 0; i < n; i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}
