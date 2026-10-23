const crypto = require("crypto");
const { supabase } = require("./db");
const { getEmbeddingTarget, callEmbeddings } = require("./model");
const { groupSourceMessagesBySharedDay } = require("../core/sharedDays");
const {
  buildRetrievalWindows,
  formatSharedDayRecall,
  lexicalCandidateAccepted,
  rankSharedDays,
  recallSourceIds,
  retrievalQueryTerms,
  selectSourceExcerpt,
  shouldContinueRecallPointer,
} = require("../core/sourceRecall");

async function readAllOwnedSourceMessages(userId, characterId) {
  const messages = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase.from("source_messages")
      .select("id,source_kind,revision_kind,role,raw_content,occurred_at,operational_message_id,revision_number,source_metadata")
      .eq("user_id", userId).eq("character_id", characterId)
      .order("occurred_at").order("created_at").range(from, from + pageSize - 1);
    if (error) throw error;
    messages.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return messages;
}

async function readSourceMessagesByIds(userId, characterId, ids) {
  const uniqueIds = [...new Set((ids || []).filter(Boolean))];
  if (!uniqueIds.length) return [];
  const chunkSize = 200;
  const chunks = [];
  for (let index = 0; index < uniqueIds.length; index += chunkSize) {
    chunks.push(uniqueIds.slice(index, index + chunkSize));
  }
  const batches = await Promise.all(chunks.map(async (chunk) => {
    const { data, error } = await supabase.from("source_messages")
      .select("id,role,raw_content,occurred_at,source_metadata")
      .eq("user_id", userId).eq("character_id", characterId).in("id", chunk);
    if (error) throw error;
    return data || [];
  }));
  return batches.flat();
}

async function latestSharedDayVersions(dayIds, userId) {
  if (!dayIds.length) return new Map();
  const { data, error } = await supabase.from("shared_life_day_versions").select("*")
    .eq("user_id", userId).in("shared_day_id", dayIds)
    .order("revision_number", { ascending: false });
  if (error) throw error;
  const latest = new Map();
  for (const version of data || []) if (!latest.has(version.shared_day_id)) latest.set(version.shared_day_id, version);
  return latest;
}

async function sourceIndexCorpus(userId, characterId) {
  const sourceMessages = await readAllOwnedSourceMessages(userId, characterId);
  const sourceById = new Map(sourceMessages.map((message)=>[message.id,message]));
  const groups = groupSourceMessagesBySharedDay(sourceMessages);
  const { data: days, error: dayError } = await supabase.from("shared_life_days").select("id,day_key")
    .eq("user_id",userId).eq("character_id",characterId);
  if (dayError) throw dayError;
  const dayByKey = new Map((days||[]).map((day)=>[day.day_key,day]));
  const rows=[];
  for(const group of groups){
    const day=dayByKey.get(group.dayKey); if(!day)continue;
    for(const sourceId of group.sourceMessageIds){const message=sourceById.get(sourceId);if(message)rows.push({message,sharedDayId:day.id});}
  }
  return rows;
}

async function readIndexRows(table, columns, orderColumn, userId, characterId, filters = {}) {
  const rows = []; const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    let query = supabase.from(table).select(columns).eq("user_id", userId).eq("character_id", characterId)
      .order(orderColumn).range(from, from + pageSize - 1);
    for (const [column, value] of Object.entries(filters)) query = query.eq(column, value);
    const { data, error } = await query; if (error) throw error;
    rows.push(...(data || [])); if (!data || data.length < pageSize) break;
  }
  return rows;
}

async function sourceRetrievalWindows(userId, characterId) {
  return buildRetrievalWindows(await sourceIndexCorpus(userId, characterId)).map((window) => ({
    ...window, windowKey: crypto.createHash("sha256").update(window.sourceMessageIds.join(":"), "utf8").digest("hex"),
  }));
}

async function sourceIndexStatus(userId,characterId) {
  const target=await getEmbeddingTarget(userId).catch(()=>null);
  const lexicalQuery=supabase.from("source_retrieval_windows").select("id",{count:"exact",head:true})
    .eq("user_id",userId).eq("character_id",characterId).eq("algorithm_version","raw-turn-window-v1");
  const embeddingQuery=target
    ? supabase.from("source_retrieval_window_embeddings").select("id",{count:"exact",head:true})
      .eq("user_id",userId).eq("character_id",characterId).eq("model_id",target.model)
    : Promise.resolve({count:0,error:null});
  const [lexical,embedding]=await Promise.all([lexicalQuery,embeddingQuery]);
  if(lexical.error||embedding.error)throw lexical.error||embedding.error;
  const lexicalCount=Number(lexical.count||0); const embeddingCount=Number(embedding.count||0);
  return {sourceCount:lexicalCount,windowCount:lexicalCount,lexicalCount,embeddingCount,embeddingConfigured:Boolean(target),embeddingModel:target?.model||null,indexVersion:"raw-turn-window-v1"};
}

async function buildSourceIndexBatch(userId,characterId,{includeEmbeddings=true,embeddingLimit=96}={}) {
  const windows=await sourceRetrievalWindows(userId,characterId); if(!windows.length)return sourceIndexStatus(userId,characterId);
  const existingWindows=await readIndexRows("source_retrieval_windows","id,window_key","id",userId,characterId,{algorithm_version:"raw-turn-window-v1"});
  const existingKeys=new Set(existingWindows.map((item)=>item.window_key));
  const lexicalRows=windows.filter((window)=>!existingKeys.has(window.windowKey)).map((window)=>({
    user_id:userId,character_id:characterId,shared_day_id:window.sharedDayId,window_key:window.windowKey,
    source_message_ids:window.sourceMessageIds,lexical_terms:window.lexicalTerms.length?window.lexicalTerms:["__empty__"],
    algorithm_version:"raw-turn-window-v1",occurred_at:window.occurredAt,
  }));
  for(let index=0;index<lexicalRows.length;index+=500){const {error}=await supabase.from("source_retrieval_windows").upsert(lexicalRows.slice(index,index+500),{onConflict:"user_id,character_id,window_key,algorithm_version",ignoreDuplicates:true});if(error)throw error;}
  const target=includeEmbeddings?await getEmbeddingTarget(userId):null;
  if(target){
    const storedWindows=await readIndexRows("source_retrieval_windows","id,window_key","id",userId,characterId,{algorithm_version:"raw-turn-window-v1"});
    const idByKey=new Map(storedWindows.map((item)=>[item.window_key,item.id]));
    const existingEmbeddings=await readIndexRows("source_retrieval_window_embeddings","window_id","window_id",userId,characterId,{model_id:target.model});
    const embeddedIds=new Set(existingEmbeddings.map((item)=>item.window_id));
    const missing=windows.filter((window)=>idByKey.has(window.windowKey)&&!embeddedIds.has(idByKey.get(window.windowKey))).slice(0,Math.max(1,Math.min(embeddingLimit,192)));
    for(let index=0;index<missing.length;index+=32){
      const batch=missing.slice(index,index+32); const vectors=await callEmbeddings({userId,target,inputs:batch.map((window)=>window.rawText.slice(0,12000))});
      const rows=batch.map((window,offset)=>({user_id:userId,character_id:characterId,window_id:idByKey.get(window.windowKey),model_id:target.model,embedding:JSON.stringify(vectors[offset]),dimensions:vectors[offset].length}));
      const {error}=await supabase.from("source_retrieval_window_embeddings").upsert(rows,{onConflict:"window_id,model_id",ignoreDuplicates:true}); if(error)throw error;
    }
  }
  return sourceIndexStatus(userId,characterId);
}

async function continueSourceIndexIfStarted(userId,characterId) {
  const status=await sourceIndexStatus(userId,characterId);
  if(status.lexicalCount>0)await buildSourceIndexBatch(userId,characterId,{includeEmbeddings:status.embeddingConfigured,embeddingLimit:192});
}

async function loadConfirmedDiaryForDay(userId,characterId,sharedDayId) {
  const {data,error}=await supabase.from("diary_entries").select("*").eq("user_id",userId).eq("character_id",characterId).eq("shared_day_id",sharedDayId)
    .order("created_at",{ascending:false}).limit(1).maybeSingle();
  if(error)throw error; return data?.status==="confirmed"?data:null;
}

async function querySourceRecallCandidates({userId,characterId,message,allowSemantic=true}) {
  const terms=retrievalQueryTerms(message); if(!terms.length)return {terms,lexicalMatches:[],semanticMatches:[],ranked:[],embeddingModel:null};
  const lexicalResult=await supabase.rpc("match_source_window_lexical",{p_user_id:userId,p_character_id:characterId,p_terms:terms,p_limit:80});
  if(lexicalResult.error)throw lexicalResult.error;
  const lexicalMatches=(lexicalResult.data||[]).filter((match)=>lexicalCandidateAccepted(match,terms));
  const admittedDays=new Set(lexicalMatches.map((match)=>match.shared_day_id));
  let semanticMatches=[]; let target=null;
  if(allowSemantic){
    try{target=await getEmbeddingTarget(userId);if(target){const [vector]=await callEmbeddings({userId,target,inputs:[message]});const semanticResult=await supabase.rpc("match_source_window_semantic",{p_user_id:userId,p_character_id:characterId,p_model_id:target.model,p_query_embedding:JSON.stringify(vector),p_limit:80});if(semanticResult.error)throw semanticResult.error;semanticMatches=semanticResult.data||[];}}
    catch(error){console.error("Semantic source recall failed; lexical recall remains available:",error.message);}
  }
  return {
    terms,lexicalMatches,semanticMatches,embeddingModel:target?.model||null,
    ranked:rankSharedDays({lexicalMatches,semanticMatches:semanticMatches.filter((item)=>admittedDays.has(item.shared_day_id))}),
  };
}

async function recallSharedDay({userId,characterId,sessionId,message,allowSemantic=true,writePointer=true}) {
  const {terms,ranked}=await querySourceRecallCandidates({userId,characterId,message,allowSemantic}); if(!terms.length)return "";
  let selected=ranked[0]||null; let diary=selected?await loadConfirmedDiaryForDay(userId,characterId,selected.sharedDayId):null;
  let pointer=null;
  if(!selected&&sessionId){const {data}=await supabase.from("memory_recall_pointers").select("*").eq("session_id",sessionId).eq("user_id",userId).eq("active",true).maybeSingle();pointer=data||null;if(pointer&&shouldContinueRecallPointer(message)){selected={sharedDayId:pointer.shared_day_id,anchorSourceMessageIds:pointer.anchor_source_message_ids,score:1};diary=await loadConfirmedDiaryForDay(userId,characterId,pointer.shared_day_id);}else if(pointer&&writePointer){await supabase.from("memory_recall_pointers").update({active:false,updated_at:new Date().toISOString()}).eq("session_id",sessionId).eq("user_id",userId);}}
  if(!selected)return "本轮自动回忆检索没有找到带有真实字面证据的旧事。不要拿仅有语义相似但尚未标定的候选猜测，也不要假装已经想起来。";
  const [{data:day,error:dayError},{data:version,error:versionError},{data:annotations,error:annotationError}]=await Promise.all([
    supabase.from("shared_life_days").select("day_key").eq("id",selected.sharedDayId).eq("user_id",userId).single(),
    supabase.from("shared_life_day_versions").select("source_message_ids").eq("shared_day_id",selected.sharedDayId).eq("user_id",userId).order("revision_number",{ascending:false}).limit(1).single(),
    diary?supabase.from("diary_review_events").select("*").eq("shared_day_id",selected.sharedDayId).eq("user_id",userId).in("event_kind",["factual_note_added","relationship_note_added"]).order("created_at",{ascending:true}):Promise.resolve({data:[],error:null}),
  ]);
  if(dayError||versionError||annotationError)throw dayError||versionError||annotationError;
  const recallIds=recallSourceIds(version.source_message_ids,selected.anchorSourceMessageIds);
  const sourceRows=await readSourceMessagesByIds(userId,characterId,recallIds);
  const byId=new Map(sourceRows.map((source)=>[source.id,source]));
  const messages=recallIds.map((id)=>byId.get(id)).filter(Boolean).map((source)=>({id:source.id,role:source.role,content:source.raw_content,occurredAt:source.source_metadata?.original_message_created_at||source.occurred_at}));
  const excerpt=selectSourceExcerpt(messages,selected.anchorSourceMessageIds,4000);
  excerpt.partial=excerpt.partial||recallIds.length<(version.source_message_ids||[]).length;
  if(writePointer&&sessionId){await supabase.from("memory_recall_pointers").upsert({session_id:sessionId,user_id:userId,character_id:characterId,shared_day_id:selected.sharedDayId,anchor_source_message_ids:selected.anchorSourceMessageIds,pointer_label:`刚才正在谈 ${day.day_key} 的共同生活`,query_terms:terms,active:true,recalled_at:new Date().toISOString(),updated_at:new Date().toISOString()},{onConflict:"session_id"});}
  return formatSharedDayRecall({dayKey:day.day_key,diary,annotations:annotations||[],messages:excerpt.messages,partial:excerpt.partial});
}

module.exports = {
  readAllOwnedSourceMessages,
  readSourceMessagesByIds,
  latestSharedDayVersions,
  sourceIndexCorpus,
  readIndexRows,
  sourceRetrievalWindows,
  sourceIndexStatus,
  buildSourceIndexBatch,
  continueSourceIndexIfStarted,
  loadConfirmedDiaryForDay,
  querySourceRecallCandidates,
  recallSharedDay,
  formatSharedDayRecall,
};
