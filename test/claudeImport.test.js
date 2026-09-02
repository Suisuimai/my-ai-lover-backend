const test=require("node:test"); const assert=require("node:assert/strict");
const {cleanClaudeSay,normalizeClaudeExport,parseTimelineCandidates,segmentClaudeMessages}=require("../core/claudeImport");
test("removes exporter thinking prefix ending in Done",()=>assert.equal(cleanClaudeSay("assistant","analysis\n\nDone\n\n真实回复"),"真实回复"));
test("segments at time gaps",()=>{const messages=normalizeClaudeExport({messages:[{role:"human",time:"8/27/2026 12:00:00",say:"早"},{role:"assistant",time:"8/27/2026 12:00:10",say:"早安"},{role:"human",time:"8/27/2026 13:00:00",say:"午安"}]});assert.equal(segmentClaudeMessages(messages).length,2)});
test("rejects invented evidence",()=>assert.throws(()=>parseTimelineCandidates(JSON.stringify({candidates:[{title:"t",body_markdown:"b",current_state:"s",index_summary:"i",evidence_quotes:["不存在"]}]}),"User: 原话"),/do not exist/));
