const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const sql = fs.readFileSync(path.join(__dirname, "..", "migrations", "028_stream_completion_status.sql"), "utf8");

test("stream completion state is durable without rewriting partial messages", () => {
  assert.match(sql, /completion_status text/);
  assert.match(sql, /finish_reason text/);
  assert.match(sql, /generation_status text not null default 'complete'/);
  assert.match(sql, /continues_message_id uuid references public\.messages/);
  assert.match(sql, /'truncated_length','truncated_eof','truncated_unknown'/);
});
