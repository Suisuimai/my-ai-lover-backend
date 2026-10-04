const test=require("node:test");
const assert=require("node:assert/strict");
const {classifyDiaryGenerationError}=require("../core/diaryFailures");

test("diary failures expose safe categories instead of raw provider errors",()=>{
  assert.equal(classifyDiaryGenerationError(Object.assign(new Error("private upstream detail"),{modelFailure:{httpStatus:429}})),"provider_rate_limited");
  assert.equal(classifyDiaryGenerationError(new Error("maximum context length exceeded")),"input_too_long");
  assert.equal(classifyDiaryGenerationError(new Error("Unexpected token in JSON"),"model_parse"),"invalid_json");
  assert.equal(classifyDiaryGenerationError(new Error("database detail"),"storage"),"diary_storage_failed");
});
