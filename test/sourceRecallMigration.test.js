const test=require("node:test"); const assert=require("node:assert/strict"); const fs=require("node:fs"); const path=require("node:path");
const sql=fs.readFileSync(path.join(__dirname,"..","migrations","025_source_memory_recall.sql"),"utf8");
test("source indexes remain attached to immutable messages",()=>{assert.match(sql,/source_message_search_documents/);assert.match(sql,/source_message_embeddings/);assert.match(sql,/references public\.source_messages/);assert.match(sql,/append-only/);});
test("lexical and semantic matching stay separate from diary prose",()=>{assert.match(sql,/match_source_lexical/);assert.match(sql,/match_source_semantic/);assert.match(sql,/memory_recall_pointers/);});
