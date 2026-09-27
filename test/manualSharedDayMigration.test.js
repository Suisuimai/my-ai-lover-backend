const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const migration = fs.readFileSync(path.join(__dirname, "..", "migrations", "023_manual_shared_day_end.sql"), "utf8");

test("a shared life day can be explicitly ended by the user", () => {
  assert.match(migration, /'manual_end'/i);
  assert.match(migration, /invalid_manual_shared_day_reason/i);
});
