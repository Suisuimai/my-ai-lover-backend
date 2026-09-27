const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const migration = fs.readFileSync(path.join(__dirname, "..", "migrations", "021_shared_life_days.sql"), "utf8");

test("shared life days keep append-only versions tied to immutable messages", () => {
  assert.match(migration, /create table if not exists public\.shared_life_days/i);
  assert.match(migration, /create table if not exists public\.shared_life_day_versions/i);
  assert.match(migration, /source_message_ids uuid\[\] not null/i);
  assert.match(migration, /shared_life_day_versions is append-only/i);
  assert.match(migration, /Every shared-day source must be an owned immutable source message/i);
});

test("shared day versions retain language-marker boundaries", () => {
  assert.match(migration, /morning_marker_source_id uuid references public\.source_messages/i);
  assert.match(migration, /night_marker_source_id uuid references public\.source_messages/i);
  assert.match(migration, /boundary_reason in \('awaiting_end','night_marker','next_shared_day'\)/i);
});
