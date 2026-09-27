const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const migration = fs.readFileSync(path.join(__dirname, "..", "migrations", "022_grounded_diaries.sql"), "utf8");

test("grounded diaries are append-only and cite immutable source messages", () => {
  assert.match(migration, /create table if not exists public\.diary_entries/i);
  assert.match(migration, /source_message_ids uuid\[\] not null/i);
  assert.match(migration, /diary_entries is append-only/i);
  assert.match(migration, /Every diary entry must cite owned immutable source messages/i);
});

test("one transaction stores diaries, verified facts, and non-factual feelings", () => {
  assert.match(migration, /create or replace function public\.save_grounded_diary/i);
  assert.match(migration, /'claim_class','verified_fact','fact_eligible',true/i);
  assert.match(migration, /'claim_class','companion_feeling','fact_eligible',false/i);
  assert.match(migration, /grant execute[\s\S]*to service_role/i);
});

test("diary generation has a separately assignable model route", () => {
  assert.match(migration, /'diary_generation'/i);
  assert.match(migration, /'long_term_memory_extraction'/i);
});
