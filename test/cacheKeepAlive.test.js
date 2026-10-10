const test = require("node:test");
const assert = require("node:assert/strict");
const { cachedPrefix, createCacheKeepAlive, usageTouchedCache } = require("../core/cacheKeepAlive");

function fakeClock() {
  let current = 0;
  const timers = [];
  return {
    now: () => current,
    setTimer: (fn, delay) => { const timer = { at: current + delay, fn }; timers.push(timer); return timer; },
    clearTimer: (timer) => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); },
    async advance(ms) {
      const target = current + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        if (!timers.length || timers[0].at > target) break;
        const timer = timers.shift();
        current = timer.at;
        await timer.fn();
      }
      current = target;
    },
  };
}

const MIN = 60 * 1000;

test("pings at 55, 110 and 165 minutes, then stops after the 3h window", async () => {
  const clock = fakeClock();
  const sent = [];
  const keepAlive = createCacheKeepAlive({ send: async () => sent.push(clock.now()), ...clock });
  keepAlive.touch("u", { prefix: [] });
  await clock.advance(10 * 60 * MIN);
  assert.deepEqual(sent, [55 * MIN, 110 * MIN, 165 * MIN]);
  assert.equal(keepAlive.size(), 0);
});

test("a new chat restarts the window", async () => {
  const clock = fakeClock();
  const sent = [];
  const keepAlive = createCacheKeepAlive({ send: async () => sent.push(clock.now()), ...clock });
  keepAlive.touch("u", { prefix: [] });
  await clock.advance(30 * MIN);
  keepAlive.touch("u", { prefix: [] });
  await clock.advance(60 * MIN);
  assert.deepEqual(sent, [85 * MIN]);
});

test("send failures do not stop the schedule", async () => {
  const clock = fakeClock();
  let calls = 0;
  const keepAlive = createCacheKeepAlive({ send: async () => { calls += 1; throw new Error("x"); }, ...clock });
  keepAlive.touch("u", { prefix: [] });
  await clock.advance(4 * 60 * MIN);
  assert.equal(calls, 3);
});

test("cachedPrefix keeps layers through the cache boundary", () => {
  const prefix = cachedPrefix([
    { role: "system", content: "a" },
    { role: "system", content: "b", cacheBoundary: true },
    { role: "system", content: "c" },
  ]);
  assert.deepEqual(prefix.map((m) => m.content), ["a", "b"]);
  assert.equal(cachedPrefix([{ role: "system", content: "a" }]), null);
});

test("usageTouchedCache requires cache activity on a non-failed call", () => {
  assert.equal(usageTouchedCache({ status: "succeeded", cache_read_tokens: 10 }), true);
  assert.equal(usageTouchedCache({ status: "succeeded", cache_write_1h_tokens: 10 }), true);
  assert.equal(usageTouchedCache({ status: "failed", cache_read_tokens: 10 }), false);
  assert.equal(usageTouchedCache({ status: "succeeded" }), false);
  assert.equal(usageTouchedCache(null), false);
});
