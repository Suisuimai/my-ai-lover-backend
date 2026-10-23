const { startChatTask } = require("../core/chatPreparation");
const {
  lexicalCandidateAccepted,
  matchedRecallPhrases,
  formatSharedDayRecall,
  rankSharedDays,
  recallSourceIds,
  retrievalQueryTerms,
  selectSourceExcerpt,
  shouldContinueRecallPointer,
} = require("../core/sourceRecall");

const { supabase } = require("./db");
const {
  getEmbeddingTarget,
  callEmbeddings,
  readSourceMessagesByIds,
} = require("./auth");
const { loadConfirmedDiaryForDay } = require("./data");

async function querySourceRecallCandidates({userId,characterId,message,allowSemantic=true,timing}) {
  const measure = (stage, work) => timing ? timing.measure(stage, work) : work();
  const terms=retrievalQueryTerms(message); if(!terms.length)return {terms,lexicalMatches:[],semanticMatches:[],ranked:[],embeddingModel:null};
  const lexicalResult=await measure("bm25_lexical", () => supabase.rpc("match_source_window_lexical",{p_user_id:userId,p_character_id:characterId,p_terms:terms,p_limit:80}));
  if(lexicalResult.error)throw lexicalResult.error;
  const lexicalMatches=(lexicalResult.data||[]).filter((match)=>lexicalCandidateAccepted(match,terms));
  let semanticMatches=[]; let target=null;
  if(allowSemantic){
    try{target=await getEmbeddingTarget(userId);if(target){const [vector]=await measure("embedding_request", () => callEmbeddings({userId,target,inputs:[message]}));const semanticResult=await measure("semantic_rrf", () => supabase.rpc("match_source_window_semantic",{p_user_id:userId,p_character_id:characterId,p_model_id:target.model,p_query_embedding:JSON.stringify(vector),p_limit:80}));if(semanticResult.error)throw semanticResult.error;semanticMatches=semanticResult.data||[];}}
    catch(error){console.error("Semantic source recall failed; lexical recall remains available:",error.message);}
  }
  const endRrf = timing?.start("semantic_rrf");
  const ranked = rankSharedDays({ lexicalMatches, semanticMatches });
  endRrf?.();
  return {
    terms,lexicalMatches,semanticMatches,embeddingModel:target?.model||null,
    ranked,
  };
}

async function recallSharedDay({userId,characterId,sessionId,message,allowSemantic=true,writePointer=true,timing,explain}) {
  const {terms,ranked}=await querySourceRecallCandidates({userId,characterId,message,allowSemantic,timing}); if(!terms.length)return "";
  const endAssembly = timing?.start("diary_source_assembly");
  try {
  let selected=ranked[0]||null;
  let pointer=null;
  if(!selected&&sessionId){const {data}=await supabase.from("memory_recall_pointers").select("*").eq("session_id",sessionId).eq("user_id",userId).eq("active",true).maybeSingle();pointer=data||null;if(pointer&&shouldContinueRecallPointer(message)){selected={sharedDayId:pointer.shared_day_id,anchorSourceMessageIds:pointer.anchor_source_message_ids,score:1,continued:true};}else if(pointer&&writePointer){await supabase.from("memory_recall_pointers").update({active:false,updated_at:new Date().toISOString()}).eq("session_id",sessionId).eq("user_id",userId);}}
  if(!selected)return "本轮自动回忆检索没有找到带有真实字面证据的旧事。不要拿仅有语义相似但尚未标定的候选猜测，也不要假装已经想起来。";
  // Diary/annotations and exact-source reads depend on different records.
  // Overlap them without changing confirmation gates or source selection.
  const diaryAndAnnotations = startChatTask(async () => {
    const diary = await loadConfirmedDiaryForDay(userId,characterId,selected.sharedDayId);
    const {data:annotations,error}=diary
      ? await supabase.from("diary_review_events").select("*").eq("shared_day_id",selected.sharedDayId).eq("user_id",userId).in("event_kind",["factual_note_added","relationship_note_added"]).order("created_at",{ascending:true})
      : {data:[],error:null};
    if(error)throw error;
    return {diary,annotations};
  });
  const versionAndSources = startChatTask(async () => {
    const {data:version,error}=await supabase.from("shared_life_day_versions").select("source_message_ids").eq("shared_day_id",selected.sharedDayId).eq("user_id",userId).order("revision_number",{ascending:false}).limit(1).single();
    if(error)throw error;
    const recallIds=recallSourceIds(version.source_message_ids,selected.anchorSourceMessageIds);
    const sourceRows=await readSourceMessagesByIds(userId,characterId,recallIds);
    return {version,recallIds,sourceRows};
  });
  const [{data:day,error:dayError},{diary,annotations},{version,recallIds,sourceRows}]=await Promise.all([
    supabase.from("shared_life_days").select("day_key").eq("id",selected.sharedDayId).eq("user_id",userId).single(),
    diaryAndAnnotations,
    versionAndSources,
  ]);
  if(dayError)throw dayError;
  const byId=new Map(sourceRows.map((source)=>[source.id,source]));
  const messages=recallIds.map((id)=>byId.get(id)).filter(Boolean).map((source)=>({id:source.id,role:source.role,content:source.raw_content,occurredAt:source.source_metadata?.original_message_created_at||source.occurred_at}));
  const excerpt=selectSourceExcerpt(messages,selected.anchorSourceMessageIds,4000);
  if(explain){
    const anchors=new Set(selected.anchorSourceMessageIds||[]);
    const evidence=messages.filter((item)=>anchors.has(item.id)).map((item)=>item.content).join("\n");
    Object.assign(explain,{dayKey:day.day_key,mode:selected.continued?"continued":"matched",terms:selected.continued?[]:matchedRecallPhrases(message,evidence)});
  }
  excerpt.partial=excerpt.partial||recallIds.length<(version.source_message_ids||[]).length;
  if(writePointer&&sessionId){await supabase.from("memory_recall_pointers").upsert({session_id:sessionId,user_id:userId,character_id:characterId,shared_day_id:selected.sharedDayId,anchor_source_message_ids:selected.anchorSourceMessageIds,pointer_label:`刚才正在谈 ${day.day_key} 的共同生活`,query_terms:terms,active:true,recalled_at:new Date().toISOString(),updated_at:new Date().toISOString()},{onConflict:"session_id"});}
  return formatSharedDayRecall({dayKey:day.day_key,diary,annotations:annotations||[],messages:excerpt.messages,partial:excerpt.partial});
  } catch (error) { endAssembly?.(false); throw error; }
  finally { endAssembly?.(); }
}

module.exports = { querySourceRecallCandidates, recallSharedDay };
