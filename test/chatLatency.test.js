const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");

test("shared-day recall reads only the matched source ids", () => {
  assert.match(source, /async function readSourceMessagesByIds[\s\S]*?\.in\("id", chunk\)/);
  assert.match(source, /Promise\.all\(chunks\.map/);
  const recall = source.slice(source.indexOf("async function recallSharedDay"), source.indexOf("app.get(\"/diary/shared-days\""));
  assert.match(recall, /recallSourceIds\(version\.source_message_ids,selected\.anchorSourceMessageIds\)/);
  assert.match(recall, /readSourceMessagesByIds\(userId,characterId,recallIds\)/);
  assert.doesNotMatch(recall, /readAllOwnedSourceMessages/);
});

test("companion chat streams visible output without a reasoning-token tax", () => {
  const chat = source.slice(source.indexOf('app.post("/chat"'));
  assert.match(chat, /purpose: "companion_chat",[\s\S]*?thinking: "disabled",[\s\S]*?maxTokens: Math\.max\(1200,/);
  assert.match(chat, /onDelta: wantsStream/);
});
