const test = require("node:test");
const assert = require("node:assert/strict");
const { buildRetrievalWindows, formatSharedDayRecall, lexicalCandidateAccepted, lexicalTerms, rankSharedDays, retrievalQueryTerms, selectSourceExcerpt, shouldContinueRecallPointer } = require("../core/sourceRecall");

test("lexical coordinates keep raw Chinese meaning searchable without summaries", () => {
  const terms = lexicalTerms("那次英语补考，Morning intimacy");
  assert.ok(terms.includes("补考"));
  assert.ok(terms.includes("英语"));
  assert.ok(terms.includes("morning"));
});

test("RRF combines lexical and semantic ranks without admitting semantic-only days", () => {
  const ranked = rankSharedDays({
    lexicalMatches:[{shared_day_id:"d1",source_message_id:"m1",matched_terms:3,lexical_score:8}],
    semanticMatches:[{shared_day_id:"d2",source_message_id:"m2",similarity:.95},{shared_day_id:"d1",source_message_id:"m3",similarity:.7}],
  });
  assert.equal(ranked[0].sharedDayId,"d1");
  assert.deepEqual(ranked[0].anchorSourceMessageIds,["m1"]);
  assert.equal(ranked.some((item)=>item.sharedDayId==="d2"),false);
});

test("large days disclose partial source reading", () => {
  const messages=Array.from({length:8},(_,index)=>({id:`m${index}`,occurredAt:`2026-09-01T0${index}:00:00Z`,role:index%2?"assistant":"user",content:"x".repeat(100)}));
  const excerpt=selectSourceExcerpt(messages,["m4"],260);
  assert.equal(excerpt.partial,true);
  assert.ok(excerpt.messages.some((message)=>message.id==="m4"));
});

test("formatted recall identifies its source and keeps annotations out of instructions", () => {
  const output=formatSharedDayRecall({dayKey:"2026-09-16",diary:{body_markdown:"我记得那天。"},annotations:[{event_kind:"relationship_note_added",content:"我很珍惜。"}],messages:[{role:"user",content:"早安"}]});
  assert.match(output,/季疏从自己的共同生活记忆中想起/);
  assert.match(output,/不是妤妤刚刚发送/);
  assert.match(output,/日记旁边留了话/);
});

test("short continuation language can follow a recall pointer",()=>{assert.equal(shouldContinueRecallPointer("然后呢？"),true);});

test("retrieval windows contain only adjacent exact source text and ids",()=>{
  const corpus=Array.from({length:8},(_,index)=>({sharedDayId:"d1",message:{id:`m${index}`,raw_content:`原话${index}`,occurred_at:`2026-09-01T0${index}:00:00Z`}}));
  const windows=buildRetrievalWindows(corpus);
  assert.deepEqual(windows[0].sourceMessageIds,["m0","m1","m2","m3","m4","m5"]);
  assert.equal(windows[0].rawText,"原话0\n原话1\n原话2\n原话3\n原话4\n原话5");
  assert.deepEqual(windows[1].sourceMessageIds,["m3","m4","m5","m6","m7"]);
});

test("every real lexical hit enters the candidate ranking",()=>{
  const terms=retrievalQueryTerms("你还记得英语补考吗");
  assert.equal(lexicalCandidateAccepted({matched_terms:1,lexical_score:.01},terms),true);
  assert.equal(lexicalCandidateAccepted({matched_terms:Math.ceil(terms.length*.4),lexical_score:2},terms),true);
  assert.equal(lexicalCandidateAccepted({matched_terms:0,lexical_score:0},terms),false);
});

test("common terms may enter candidates but remain subject to BM25 and RRF ranking",()=>{
  assert.equal(lexicalCandidateAccepted({matched_terms:1,lexical_score:2.410},retrievalQueryTerms("今天")),true);
  assert.equal(lexicalCandidateAccepted({matched_terms:1,lexical_score:2.830},retrievalQueryTerms("我们")),true);
});

test("source range disclosure comes after exact messages",()=>{
  const output=formatSharedDayRecall({dayKey:"2026-09-16",diary:{body_markdown:"日记"},messages:[{role:"user",content:"原话"}],partial:true});
  assert.ok(output.indexOf("妤妤：原话")<output.indexOf("读取范围：这里只读取"));
});
