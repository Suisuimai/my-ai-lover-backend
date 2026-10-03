const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const sql=fs.readFileSync(path.join(__dirname,"..","migrations","026_source_retrieval_windows.sql"),"utf8");

test("retrieval windows keep exact source ids and never store a generated summary",()=>{
  assert.match(sql,/source_message_ids uuid\[\]/);
  assert.doesNotMatch(sql,/summary\s+text|narrative\s+text/i);
  assert.match(sql,/append-only/);
});

test("window lexical and semantic routes remain separately inspectable",()=>{
  assert.match(sql,/match_source_window_lexical/);
  assert.match(sql,/match_source_window_semantic/);
  assert.match(sql,/invalid_retrieval_window_ownership/);
});
