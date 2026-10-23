const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const recallSource = fs.readFileSync(path.join(__dirname, "..", "services", "recall.js"), "utf8");
const chatSource = fs.readFileSync(path.join(__dirname, "..", "routes", "chat.js"), "utf8");

test("shared-day recall reads only the matched source ids", () => {
  assert.match(recallSource, /async function readSourceMessagesByIds[\s\S]*?\.in\("id", chunk\)/);
  assert.match(recallSource, /Promise\.all\(chunks\.map/);
  const recallStart = recallSource.indexOf("async function recallSharedDay");
  const recallEnd = recallSource.indexOf("\nmodule.exports", recallStart);
  const recall = recallSource.slice(recallStart, recallEnd > recallStart ? recallEnd : undefined);
  assert.match(recall, /recallSourceIds\(version\.source_message_ids,selected\.anchorSourceMessageIds\)/);
  assert.match(recall, /readSourceMessagesByIds\(userId,characterId,recallIds\)/);
  assert.doesNotMatch(recall, /readAllOwnedSourceMessages/);
});

test("companion chat streams visible output without a reasoning-token tax", () => {
  const chat = chatSource.slice(chatSource.indexOf('router.post("/chat"'));
  assert.match(chat, /purpose: "companion_chat",[\s\S]*?thinking: "disabled",[\s\S]*?maxTokens: Math\.max\(1200,/);
  assert.match(chat, /onDelta: wantsStream/);
  assert.match(chat, /recallSharedDay\(\{userId:req\.user\.id,characterId:character\.id,sessionId,message,allowSemantic:false/);
  assert.match(chat, /settingsPromise[\s\S]*?Promise\.all\(\[[\s\S]*?heartbeatPromise/);
});
