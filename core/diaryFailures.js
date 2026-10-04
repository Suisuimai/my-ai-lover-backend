function classifyDiaryGenerationError(error,stage="model_request") {
  const message=String(error?.message||"").toLowerCase();
  const httpStatus=Number(error?.modelFailure?.httpStatus||0);
  const modelCode=String(error?.modelFailure?.code||"").toLowerCase();
  if(message.includes("empty reply")||message.includes("empty response"))return "empty_reply";
  if(message.includes("maximum context")||message.includes("context length")||message.includes("context_length")||modelCode.includes("context"))return "input_too_long";
  if(message.includes("incomplete structured reply")||message.includes("finish_reason: length")||message.includes("max_tokens")||modelCode==="incomplete_structured_reply")return "output_length";
  if(message.includes("json")||message.includes("diary model")||message.includes("omitted its title"))return "invalid_json";
  if(message.includes("source message is missing"))return "source_message_missing";
  if(httpStatus===429||message.includes("429")||message.includes("rate limit")||message.includes("too many requests"))return "provider_rate_limited";
  if(httpStatus===402||message.includes("402")||message.includes("insufficient")||message.includes("quota")||message.includes("credit"))return "provider_quota";
  if([401,403].includes(httpStatus)||message.includes("401")||message.includes("403")||message.includes("unauthorized")||message.includes("api key"))return "provider_auth";
  if(httpStatus===404)return "provider_model_unavailable";
  if(httpStatus>=500)return "provider_unavailable";
  if(message.includes("fetch failed")||message.includes("timeout")||message.includes("timed out")||message.includes("econn"))return "provider_network";
  if(stage==="storage")return "diary_storage_failed";
  if(stage==="validation")return "diary_validation_failed";
  return "diary_generation_failed";
}

module.exports={classifyDiaryGenerationError};
