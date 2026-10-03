const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const sql = fs.readFileSync(path.join(__dirname, "..", "migrations", "024_diary_review_annotations.sql"), "utf8");

test("diary reviews are append-only and support future batches without exposing batch UI", () => {
  assert.match(sql, /create table if not exists public\.diary_review_events/i);
  assert.match(sql, /entry_confirmation_revoked/);
  assert.match(sql, /factual_note_added/);
  assert.match(sql, /relationship_note_added/);
  assert.match(sql, /batch_id uuid/);
  assert.match(sql, /diary_review_events_no_update[\s\S]*reject_diary_review_event_update/i);
});

test("review transaction can append a corrected diary version", () => {
  assert.match(sql, /create or replace function public\.append_diary_review/i);
  assert.match(sql, /supersedes_entry_id/);
  assert.match(sql, /p_result_validation_issues/);
});
