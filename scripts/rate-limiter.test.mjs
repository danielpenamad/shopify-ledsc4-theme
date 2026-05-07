#!/usr/bin/env node
// Unit tests for scripts/rate-limiter.mjs.
// Zero dependencies. Run: node scripts/rate-limiter.test.mjs

import { createTokenBucket, runWithConcurrency } from './rate-limiter.mjs';

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (condition) { passed++; }
  else { failed++; failures.push(message); console.error(`  ✗ ${message}`); }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function testBurstCapacity() {
  console.log('Test 1: bucket starts at full capacity — first N acquires resolve immediately');
  const b = createTokenBucket({ capacity: 5, refillPerSec: 1 });
  const t0 = Date.now();
  await Promise.all([b.acquire(), b.acquire(), b.acquire(), b.acquire(), b.acquire()]);
  const dt = Date.now() - t0;
  assert(dt < 50, `expected burst <50ms, got ${dt}ms`);
}

async function testRefillThrottles() {
  console.log('Test 2: after burst, further acquires are throttled at refillPerSec');
  const b = createTokenBucket({ capacity: 2, refillPerSec: 5 }); // refill every 200ms
  await Promise.all([b.acquire(), b.acquire()]); // burn the burst
  const t0 = Date.now();
  // 3 more acquires at 5/sec = expected ~600ms total
  await b.acquire();
  await b.acquire();
  await b.acquire();
  const dt = Date.now() - t0;
  assert(dt >= 400, `expected ≥400ms throttle, got ${dt}ms`);
  assert(dt < 1500, `expected <1500ms (sanity), got ${dt}ms`);
}

async function testFifoOrdering() {
  console.log('Test 3: pending acquires resolve in FIFO order');
  const b = createTokenBucket({ capacity: 1, refillPerSec: 5 });
  await b.acquire(); // empty bucket
  const order = [];
  const p1 = b.acquire().then(() => order.push('a'));
  const p2 = b.acquire().then(() => order.push('b'));
  const p3 = b.acquire().then(() => order.push('c'));
  await Promise.all([p1, p2, p3]);
  assert(order.join(',') === 'a,b,c', `expected FIFO a,b,c got ${order.join(',')}`);
}

async function testPause() {
  console.log('Test 4: pause(ms) holds new acquires until pause elapses');
  const b = createTokenBucket({ capacity: 5, refillPerSec: 5 });
  b.pause(300);
  const t0 = Date.now();
  await b.acquire();
  const dt = Date.now() - t0;
  assert(dt >= 250, `expected ≥250ms pause, got ${dt}ms`);
  assert(dt < 600, `expected <600ms (sanity), got ${dt}ms`);
}

async function testConcurrencyOrder() {
  console.log('Test 5: runWithConcurrency preserves input order in results');
  const items = [10, 5, 30, 1, 20];
  const r = await runWithConcurrency({
    items,
    concurrency: 2,
    work: async (n) => { await sleep(n); return n * 2; },
  });
  assert(r.length === items.length, `expected 5 results`);
  for (let i = 0; i < items.length; i++) {
    assert(r[i].ok === true && r[i].value === items[i] * 2, `result[${i}] mismatch`);
  }
}

async function testConcurrencyParallel() {
  console.log('Test 6: runWithConcurrency actually runs in parallel');
  const items = [200, 200, 200, 200];
  const t0 = Date.now();
  await runWithConcurrency({
    items,
    concurrency: 4,
    work: (ms) => sleep(ms),
  });
  const dt = Date.now() - t0;
  // With concurrency 4, all 4 run in parallel — total should be ~200ms not 800ms.
  assert(dt < 400, `expected parallel ~200ms, got ${dt}ms (sequential would be ~800ms)`);
}

async function testConcurrencyErrorIsCaptured() {
  console.log('Test 7: runWithConcurrency captures errors per-item, does not abort pool');
  const items = ['ok1', 'fail', 'ok2'];
  const r = await runWithConcurrency({
    items,
    concurrency: 2,
    work: async (s) => {
      if (s === 'fail') throw new Error('boom');
      return s;
    },
  });
  assert(r[0].ok === true && r[0].value === 'ok1', `[0] should be ok`);
  assert(r[1].ok === false && /boom/.test(r[1].error?.message), `[1] should be error`);
  assert(r[2].ok === true && r[2].value === 'ok2', `[2] should be ok despite [1] failing`);
}

async function testRateAcrossConcurrency() {
  console.log('Test 8: token bucket caps aggregate rate across concurrent workers');
  // capacity 5, refill 5/sec → burst 5 then 5/sec sustained
  const b = createTokenBucket({ capacity: 5, refillPerSec: 5 });
  const items = Array.from({ length: 15 }, (_, i) => i);
  const t0 = Date.now();
  await runWithConcurrency({
    items,
    concurrency: 5,
    work: async () => {
      await b.acquire();
      // simulate API call (10ms) — much shorter than refill interval
      await sleep(10);
    },
  });
  const dt = Date.now() - t0;
  // 15 items, 5 burst free, 10 throttled at 5/sec = ~2000ms minimum.
  assert(dt >= 1500, `expected ≥1500ms (rate-capped), got ${dt}ms`);
  assert(dt < 3500, `expected <3500ms (sanity), got ${dt}ms`);
}

async function main() {
  await testBurstCapacity();
  await testRefillThrottles();
  await testFifoOrdering();
  await testPause();
  await testConcurrencyOrder();
  await testConcurrencyParallel();
  await testConcurrencyErrorIsCaptured();
  await testRateAcrossConcurrency();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('\nFailures:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
