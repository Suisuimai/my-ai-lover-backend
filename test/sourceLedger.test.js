const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const migration = fs.readFileSync(path.join(__dirname, "..", "migrations", "019_immutable_source_ledger.sql"), "utf8");

test("immutable source ledger archives live inserts and content corrections", () => {
  assert.match(migration, /create table if not exists public\.source_messages/i);
  assert.match(migration, /after insert or update of content on public\.messages/i);
  assert.match(migration, /source_messages is append-only/i);
  assert.match(migration, /revision_kind in \('original','correction'\)/i);
});

test("future generated artifacts must cite immutable source message ids", () => {
  assert.match(migration, /create table if not exists public\.derived_artifact_events/i);
  assert.match(migration, /source_message_ids uuid\[\] not null/i);
  assert.match(migration, /cardinality\(source_message_ids\) > 0/i);
  assert.match(migration, /Every derived artifact must cite owned immutable source message IDs/i);
});
