const test = require("node:test");
const assert = require("node:assert/strict");
const { startChatTask } = require("../core/chatPreparation");

test("early work begins before consumption and keeps its result", async () => {
  let started = false;
  const value = {};
  const task = startChatTask(() => { started = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, true);
  assert.equal(await task, value);
});

test("early rejection remains observable without an unhandled rejection", async () => {
  const failure = new Error("failed");
  const task = startChatTask(() => { throw failure; });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(task, failure);
});
