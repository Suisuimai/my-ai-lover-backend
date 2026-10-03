const test = require("node:test");
const assert = require("node:assert/strict");
const { formatSharedDayRecall, lexicalTerms, rankSharedDays, selectSourceExcerpt, shouldContinueRecallPointer } = require("../core/sourceRecall");

test("lexical coordinates keep raw Chinese meaning searchable without summaries", () => {
  const terms = lexicalTerms("那次英语补考，Morning intimacy");
  assert.ok(terms.includes("补考"));
  assert.ok(terms.includes("英语"));
  assert.ok(terms.includes("morning"));
});

test("hybrid ranking combines lexical and semantic coordinates by shared day", () => {
  const ranked = rankSharedDays({
    lexicalMatches:[{shared_day_id:"d1",source_message_id:"m1",matched_terms:3,lexical_score:8}],
    semanticMatches:[{shared_day_id:"d2",source_message_id:"m2",similarity:.95},{shared_day_id:"d1",source_message_id:"m3",similarity:.7}],
    queryTermCount:4,
  });
  assert.equal(ranked[0].sharedDayId,"d1");
  assert.deepEqual(ranked[0].anchorSourceMessageIds,["m1","m3"]);
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
