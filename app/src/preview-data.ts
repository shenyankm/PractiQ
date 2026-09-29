import sample from "../fixtures/sample.json";
import english from "../fixtures/english.json";
import composite from "../fixtures/composite.json";
import type { Answer, Bank, Question, QuestionRow, Request, Session, SettingsResult, Preview } from "./api";
import type { Request as AiRequest, Summary, Batch } from "./ai-api";
import { importDemoRows, importDemoTask } from "./import-demo";
import type { PreviewScenario } from "./preview-mode";

const now = Date.now();
const imageUrl = new URL("../fixtures/resources/practiq-agent/artifacts/194d631965b1f86c4cf32eac39eee06a6a0523a127204b3995999240546deeaa/fixture/0-194d631965b1f86c4cf32eac39eee06a6a0523a127204b3995999240546deeaa.png", import.meta.url).href;
const audioUrl = new URL("../fixtures/resources/audio/chimes.wav", import.meta.url).href;
const banks: Bank[] = ["基础知识 · 全题型", "英语专项 · 听力与写作", "阅读与组合题", "新建空题库"].map((title,i)=>({id:`preview-bank-${i}`,title,description:i===3 ? "用于预览空题库与新增题目。":"开发预览样例，可编辑、收藏和练习；重置后恢复。",count:0,createdAt:now-i*86400000}));
let rows: QuestionRow[] = [sample,english,composite].flatMap((fixture,bankIndex)=> {
  const questions=fixture.questions as Question[];
  return questions.map((q,i)=>({id:`${bankIndex}-${q.id}`,bankId:banks[bankIndex].id,bankTitle:banks[bankIndex].title,
    question:{parentId:null,passage:[],allowReuse:false,...q},materials:questions.filter(p=>p.id===q.parentId),
    groups:bankIndex===0 ? sample.groups.filter(g=>g.questionIds.includes(q.id!)).map((g,j)=>({...g,id:`group-${j}`})):[],
    visuals:bankIndex===0 ? sample.visualElements.filter(v=>v.questionIds.includes(q.id!)).map((v,j)=>({...v,id:`visual-${j}`})):[],
    sources:[{fileName:"演示源文件.pdf",page:i+1}],warnings:q.needsReview ? ["原文未提供参考答案，请人工确认。"]:[],missingAssets:false,favorite:i%3===0,latestResult:i%4===0 ? false:i%4===1 ? true:null}));
});
const sampleRows=structuredClone(rows.filter(q=>q.bankId==="preview-bank-0"));
function roots(items:QuestionRow[]) { return items.filter(r=>!r.question.parentId).map(r=>({...r,children:items.filter(c=>c.bankId===r.bankId && c.question.parentId===r.question.id),answerableCount:Math.max(1,items.filter(c=>c.bankId===r.bankId && c.question.parentId===r.question.id).length)})); }
function questionType(q:Question) { return q.questionKind || (q.answerMode==="choice" ? q.choiceVariant : q.answerMode) || "unknown"; }
function leaves(items:QuestionRow[]) { return items.filter(q=>!rows.some(c=>c.bankId===q.bankId && c.question.parentId===q.question.id)); }
function bankList() { return banks.map(b=>({...b,count:leaves(rows.filter(q=>q.bankId===b.id)).length})); }
function makeSession(id:string,title:string,kind:Session["kind"],done:boolean,items=rows.slice(0,9)):Session {
  return {id,title,kind,createdAt:now-3600000,finishedAt:done ? now-600000:null,submittedAt:kind!=="practice" && done ? now-600000:null,position:0,mode:"ordered",clockNow:Date.now(),deadlineAt:kind==="mock_exam" && !done ? Date.now()+1800000:null,
    attempts:structuredClone(items).map((snapshot,i)=>({ordinal:i,snapshot,answer:done || i===0 ? snapshot.question.answerPayload:null,autoResult:done && i%3!==2 ? i%3===0:null,result:done && i%3!==2 ? i%3===0:null,gradeKind:done && i%3!==2 ? "auto":"ungraded",maxCents:1000,earnedCents:done && i%3!==2 ? i%3===0 ? 1000:400:null,submittedAt:done ? now-600000:null,skipped:done && i===7,elapsedMs:30000,flagged:i===2}))};
}
const sessions=[makeSession("preview-practice","每日练习 · 未完成","practice",false),makeSession("preview-exam","模拟考试 · 进行中","mock_exam",false),makeSession("preview-review","自主测验 · 待评分","self_test",true),makeSession("preview-finished","基础知识 · 已完成","practice",true)];
sessions[2].finishedAt=null;
sessions[2].attempts[4].gradeKind="ungraded";
sessions[2].attempts[4].earnedCents=null;
sessions[2].attempts[4].result=null;
const gradingSession=makeSession("preview-grading","主观题 · 评分与恢复","self_test",true,Array.from({length:5},()=>rows[4]));
gradingSession.finishedAt=null;
gradingSession.attempts.forEach((a,i)=>{a.result=null;a.earnedCents=null;a.gradeKind="ungraded";a.snapshot.question.stem=`评分场景 ${i+1}：${a.snapshot.question.stem}`;});
gradingSession.attempts[0].grading={lastRequest:{status:"unknown",error:"示例：请求中断，结果待确认"}};
gradingSession.attempts[1].grading={lastRequest:{status:"ungraded",error:"示例：模型暂时不可用，可重试"}};
Object.assign(gradingSession.attempts[2],{gradeKind:"ai",earnedCents:600,result:false,grading:{ai:{status:"graded",result:{scoreCents:600,maxCents:1000,reason:"演示部分得分",evidence:["覆盖目标设定"],reviewReasons:[]}}}});
Object.assign(gradingSession.attempts[3],{gradeKind:"manual",earnedCents:800,result:false,grading:{manual:{reason:"演示人工复核",scoreCents:800}}});
gradingSession.attempts[4].snapshot.question.answerPayload=null;
sessions.push(gradingSession);
let settings:SettingsResult={config:{base_url:"https://example.invalid/v1",model_id:"demo-model"},hasApiKey:true};
let tasks:Summary[]=[...structuredClone(importDemoRows),
  {...importDemoRows[4],threadId:"demo-imported",bankTitle:"已入库 · 基础知识",importedBankId:"preview-bank-0"},
  {...importDemoRows[4],threadId:"demo-import-failed",bankTitle:"入库失败 · 可重试"}];
const batches:Batch[]=[{id:"demo-batch",status:"paused",items:[
  {threadId:"demo-imported",checkpointId:"demo-checkpoint-4",title:"基础知识",questionCount:9,reviewCount:1,partial:false,previousVersion:false,status:"imported",bankId:"preview-bank-0",error:null},
  {threadId:"demo-import-failed",checkpointId:"demo-checkpoint-4",title:"待重试题库",questionCount:9,reviewCount:1,partial:true,previousVersion:false,status:"failed",bankId:null,error:{code:"DEMO_IMPORT_ERROR",message:"示例写入失败，可继续未成功项。"}}
]}];
function getSession(id:string) {const s=sessions.find(s=>s.id===id);if(!s)throw new Error("示例练习不存在");return s;}
function summary(s:Session) {const a=s.attempts;return {...s,attempts:undefined,count:a.length,answered:a.filter(a=>a.submittedAt!=null).length,draftAnswered:a.filter(a=>a.answer!=null).length,correct:a.filter(a=>a.result===true).length,graded:a.filter(a=>a.result!=null).length,skipped:a.filter(a=>a.skipped).length,elapsedMs:a.reduce((n,a)=>n+a.elapsedMs,0),selfGraded:a.filter(a=>a.gradeKind==="self").length,autoGraded:a.filter(a=>a.gradeKind==="auto").length,pendingGrades:a.filter(a=>a.submittedAt && a.gradeKind==="ungraded").length,totalCents:a.reduce((n,a)=>n+(a.maxCents||0),0),earnedCents:a.reduce((n,a)=>n+(a.earnedCents||0),0),lastActiveAt:now};}
function page<T>(items:T[],offset=0,limit=20) {return {items:items.slice(offset,offset+limit),total:items.length,offset};}
function preview():Preview {return {ticket:"preview-ticket",title:"示例导入题库",count:9,reviewCount:1,warnings:["演示解析结果，包含一道缺少参考答案的题目。"],status:"PARTIAL",processing:null,missingAssets:[],assetCount:1,questions:sample.questions as Question[],groups:[],visuals:[]};}
function filtered(r:{bank_id?:string|null;bank_ids?:string[];search?:string;mode?:string;filter?:string},empty:boolean) {
  return empty ? []:rows.filter(q=>(!r.bank_id || q.bankId===r.bank_id) && (!r.bank_ids?.length || r.bank_ids.includes(q.bankId)) && (!r.search || `${q.question.stem} ${q.bankTitle}`.toLowerCase().includes(r.search.toLowerCase())) && (!r.mode || q.question.answerMode===r.mode) && (r.filter!=="wrong" || q.latestResult===false) && (r.filter!=="favorite" || q.favorite) && (r.filter!=="review" || q.question.needsReview) && (r.filter!=="unattempted" || q.latestResult===null));
}
function score(s:Session,ordinal:number,answer:Answer|null) {
  const a=s.attempts[ordinal];a.answer=answer;a.submittedAt=Date.now();
  if(a.snapshot.question.answerPayload && a.snapshot.question.answerMode!=="short_answer") {a.result=JSON.stringify(answer)===JSON.stringify(a.snapshot.question.answerPayload);a.autoResult=a.result;a.gradeKind="auto";a.earnedCents=a.result ? a.maxCents:0;}
}
function addBank(title:string) {const id=crypto.randomUUID();banks.push({id,title,description:"演示导入",createdAt:Date.now(),count:9});rows.push(...structuredClone(sampleRows).map(q=>({...q,id:crypto.randomUUID(),bankId:id,bankTitle:title})));return {duplicate:false,bankId:id,count:9};}
function request(r:Request,scenario:PreviewScenario):unknown {
  const empty=banks.length===0;
  switch(r.type) {
    case "language": return null;
    case "save_language": return r.locale;
    case "info": return {version:"开发预览",dataDirectory:"仅内存 · 不写入本地数据"};
    case "banks": return empty ? []:bankList();
    case "banks_page": return page(empty ? []:bankList(),r.offset,r.limit);
    case "questions_page": return page(roots(filtered(r,empty)).map(q=>({...q,missingAssets:scenario==="missing"})),r.offset,r.limit);
    case "question_stats": {const q=roots(filtered(r,empty));const counts=new Set([0]);for(const root of q){const size=root.answerableCount;for(const n of [...counts])counts.add(n+size);}return {count:q.reduce((n,r)=>n+r.answerableCount,0),feasibleCounts:[...counts].filter(n=>n>0).sort((a,b)=>a-b),types:q.reduce<Record<string,number>>((o,q)=>{const type=questionType(q.question);o[type]=(o[type]||0)+1;return o;},{})};}
    case "sessions_page": return page(empty ? []:sessions.filter(s=>!r.filter || r.filter==="all" || (r.filter==="active" ? !s.finishedAt && !s.submittedAt:r.filter==="review" ? !s.finishedAt && !!s.submittedAt:!!s.finishedAt)).map(summary),r.offset,r.limit);
    case "unfinished_session": return empty || !sessions.some(s=>!s.finishedAt && !s.submittedAt) ? null:summary(sessions.find(s=>!s.finishedAt && !s.submittedAt)!);
    case "session": return {...getSession(r.id),clockNow:Date.now()};
    case "settings": return settings;
    case "save_settings": settings={config:r.config,hasApiKey:r.api_key ? true:settings.hasApiKey};return settings;
    case "test_settings": return null;
    case "save_bank": {const b=banks.find(b=>b.id===r.id);if(b)Object.assign(b,{title:r.title,description:r.description});else banks.push({id:crypto.randomUUID(),title:r.title,description:r.description,count:0,createdAt:Date.now()});return b?.id || banks.at(-1)!.id;}
    case "delete_bank": {const i=banks.findIndex(b=>b.id===r.id);if(i>=0)banks.splice(i,1);rows=rows.filter(q=>q.bankId!==r.id);return null;}
    case "delete_question": {const row=rows.find(q=>q.id===r.id);rows=rows.filter(q=>q.id!==r.id && !(row && q.bankId===row.bankId && q.question.parentId===row.question.id));return null;}
    case "favorite": {const q=rows.find(q=>q.id===r.id);if(q)q.favorite=r.value;return r.value;}
    case "review_question": {const q=rows.find(q=>q.id===r.id);if(q){q.question.needsReview=!r.reviewed;q.reviewedAt=r.reviewed ? Date.now():null;}return q?.reviewedAt ?? null;}
    case "save_question_tree": {rows=rows.filter(q=>!(q.bankId===r.bank_id && (q.id===r.root_id || r.questions.some(v=>v.id===q.question.id))));for(const q of r.questions)rows.push({id:q.id!,bankId:r.bank_id,bankTitle:banks.find(b=>b.id===r.bank_id)?.title||"",question:q,groups:[],visuals:[],sources:[],warnings:[],missingAssets:false,favorite:false,latestResult:null});return r.questions[0].id;}
    case "merge_banks": {const id=crypto.randomUUID();banks.push({id,title:r.title,description:"示例合并题库",createdAt:Date.now(),count:0});rows.push(...structuredClone(rows.filter(q=>r.bank_ids.includes(q.bankId))).map(q=>({...q,id:crypto.randomUUID(),bankId:id,bankTitle:r.title})));return {bankId:id,count:rows.filter(q=>q.bankId===id).length};}
    case "pick_import": return preview();
    case "import": return addBank(r.title);
    case "add_example_bank": return addBank("示例题库");
    case "backup": case "export_bank": return {path:"[演示] 未创建文件"};
    case "restore": return {recoveryPath:"[演示] 未替换本地数据"};
    case "preview_paper": {
      const q=r.request;let candidates=roots(filtered({bank_ids:q.bank_ids,search:q.search,mode:q.mode,filter:q.filter},empty));
      if(q.random)candidates=candidates.map(row=>({row,key:Math.random()})).sort((a,b)=>a.key-b.key).map(item=>item.row);
      const quotas={...q.quotas};let remaining=q.count;
      const selected=candidates.filter(root=>{
        if(q.selection==="manual")return q.question_ids.includes(root.id) || root.children.some(c=>q.question_ids.includes(c.id));
        if(q.selection==="quota"){const type=questionType(root.question);if(!quotas[type])return false;quotas[type]--;return true;}
        if(root.answerableCount>remaining)return false;remaining-=root.answerableCount;return true;
      }).flatMap<QuestionRow>(root=>root.children.length ? root.children.map(child=>({...child,rootId:root.id,rootType:questionType(root.question)})):[root]);
      const total=q.total_cents;const scores=selected.map((_,i)=>Math.floor(total/Math.max(1,selected.length))+(i<total%Math.max(1,selected.length) ? 1:0));
      return {questionIds:selected.map(q=>q.id),questions:selected,scores,count:selected.length,digest:"preview-paper"};
    }
    case "start_paper": {const s=makeSession(crypto.randomUUID(),"示例练习",r.paper.kind,false,r.paper.question_ids.map(id=>rows.find(q=>q.id===id)!));s.attempts.forEach((a,i)=>{a.answer=null;a.maxCents=r.paper.scores[i] ?? null;});s.deadlineAt=r.paper.minutes ? Date.now()+r.paper.minutes*60000:null;sessions.unshift(s);return s;}
    case "retry_wrong": {const previous=getSession(r.id);const s=makeSession(crypto.randomUUID(),"错题重练","practice",false,previous.attempts.filter(a=>a.result===false).map(a=>a.snapshot as QuestionRow));sessions.unshift(s);return s;}
    case "save_draft": {const a=getSession(r.id).attempts[r.ordinal];a.answer=r.answer;a.elapsedMs=r.elapsed_ms;return null;}
    case "save_attempt": {const s=getSession(r.id);const a=s.attempts[r.ordinal];a.answer=r.answer;a.elapsedMs=r.elapsed_ms;a.skipped=r.skip;if(r.submit)score(s,r.ordinal,r.answer);if(r.self_result!==null){a.result=r.self_result;a.gradeKind="self";}return s;}
    case "self_assess": {const s=getSession(r.id);Object.assign(s.attempts[r.ordinal],{result:r.result,gradeKind:"self"});return s;}
    case "position": {const s=getSession(r.id);s.position=r.position;return s;}
    case "flag": {const s=getSession(r.id);s.attempts[r.ordinal].flagged=r.value;return s;}
    case "manual_score": {const s=getSession(r.id);const a=s.attempts[r.ordinal];Object.assign(a,{earnedCents:r.cents,result:r.cents===a.maxCents,gradeKind:"manual",grading:{...a.grading,manual:{reason:r.reason,scoreCents:r.cents}}});return s;}
    case "finish": case "complete_review": case "submit_paper": {const s=getSession(r.id);if(r.type==="submit_paper"){s.attempts.forEach(a=>{if(!a.submittedAt && r.submit_drafts && a.answer)score(s,a.ordinal,a.answer);});s.submittedAt=Date.now();}s.finishedAt=Date.now();return s;}
    case "pick_audio": return {reference:english.questions[0].audioRef,duration:3};
    case "pick_audio_qr": case "decode_audio_qr": return [{url:"https://example.com/listening.mp3",label:""}];
    case "import_audio_url": return {audio:{reference:english.questions[0].audioRef,duration:3},links:[]};
    case "release_audio": return null;
    case "listening_playback": return {used:r.action==="start" ? 1:0,position:r.position||0,active:r.action==="start",limit:2,restricted:false};
    case "asset": throw new Error("资产请求应通过专用演示读取入口");
  }
}
function aiRequest(r:AiRequest):unknown {
  switch(r.type) {
    case "list": {const states:Record<string,string[]>={active:["RUNNING","PENDING","PAUSING"],paused:["PAUSED"],completed:["COMPLETED"],cancelled:["CANCELLED"],failed:["FAILED"],review:["WAITING_REVIEW"],interrupted:["INTERRUPTED"],expired:["EXPIRED"]};return {items:tasks.filter(t=>!r.filter || states[r.filter].includes(t.state)).slice(r.offset,r.offset+20),hasMore:tasks.filter(t=>!r.filter || states[r.filter].includes(t.state)).length>r.offset+20};}
    case "get": {const row=tasks.find(t=>t.threadId===r.id);if(!row)throw new Error("示例任务不存在");const task=importDemoTask(importDemoRows.find(t=>t.state===row.state)?.threadId || "demo-001");return {...task,threadId:r.id,state:row.state,allowedActions:["RUNNING","PENDING"].includes(row.state) ? ["pause","interrupt"]:["PAUSED","CANCELLED","INTERRUPTED"].includes(row.state) ? ["resume"]:row.state==="FAILED" ? ["retry_failed"]:row.state==="WAITING_REVIEW" ? ["accept_partial"]:[]};}
    case "operations": return [];
    case "batches": return {...page(batches,r.offset),operations:tasks.some(t=>t.threadId==="demo-import-failed") && batches.some(b=>b.items.some(i=>i.status==="failed")) ? [{threadId:"demo-import-failed",checkpointId:"demo-checkpoint-4",state:"failed",error:{message:"示例入库失败，可重试。"}}]:[]};
    case "select_document": return {token:"preview-files",fileNames:["高等数学.pdf","课堂练习.docx","补充习题.xlsx"]};
    case "pick_document": case "reparse": {const id=crypto.randomUUID();tasks.unshift({...importDemoRows[0],threadId:id,bankTitle:r.type==="pick_document" ? r.details.title:"重新解析示例",createdAt:new Date().toISOString()});return {threadId:id,threadIds:[id]};}
    case "delete": tasks=tasks.filter(t=>t.threadId!==r.id);return {deleted:true};
    case "control": {const t=tasks.find(t=>t.threadId===r.id)!;t.state=r.action==="pause" ? "PAUSED":r.action==="interrupt" ? "CANCELLED":r.action==="accept_partial" ? "COMPLETED":"RUNNING";return null;}
    case "preview": return preview();
    case "review": return {threadId:r.id,checkpointId:"preview-checkpoint",state:"WAITING_REVIEW",phase:"review",units:[{stage:"result",index:0,questions:sample.questions,groups:[],visualElements:[]}],failures:[],quality:{reviewRequired:true,reviewQuestionCount:1,issues:[]},questionSources:[]};
    case "prepare_batch": {const b:Batch={id:crypto.randomUUID(),status:"ready",items:r.ids.map(id=>({threadId:id,checkpointId:"preview",title:tasks.find(t=>t.threadId===id)?.bankTitle||"示例",questionCount:9,reviewCount:1,partial:false,previousVersion:false,status:"pending",bankId:null,error:null}))};batches.push(b);return b;}
    case "run_batch": {const b=batches.find(b=>b.id===r.id)!;b.status="completed";b.items.forEach(i=>{i.status="imported";i.bankId=addBank(i.title).bankId;});return b;}
    case "cancel_batch": {const b=batches.find(b=>b.id===r.id);if(b)b.status="paused";return null;}
    case "replay": return null;
    case "grade": {const s=getSession(r.id);const a=s.attempts[r.ordinal];a.gradeKind="ai";a.earnedCents=Math.floor((a.maxCents||1000)*0.6);a.result=false;a.grading={ai:{status:"graded",result:{scoreCents:a.earnedCents,maxCents:a.maxCents||1000,reason:"演示评分：覆盖部分要点。未调用模型。",evidence:["示例参考答案"],reviewReasons:[]}}};return s;}
    case "review_asset": throw new Error("此演示审核单元没有图片");
  }
}
let initialized = false;
function initialize(scenario: PreviewScenario) {
  if (initialized) return;
  initialized = true;
  if (scenario === "empty") { banks.length=0; rows=[]; sessions.length=0; tasks=[]; batches.length=0; }
  if (scenario === "unconfigured") settings={config:{base_url:null,model_id:null},hasApiKey:false};
  if (scenario === "many") {
    for (let i=1;i<=40;i++) {
      addBank(`综合复习 · 第 ${i} 单元`);
      sessions.push(makeSession(`history-${i}`,`复习记录 · 第 ${i} 次`,"practice",true));
      tasks.push({...importDemoRows[i%10],threadId:`history-task-${i}`,bankTitle:`综合复习 · 第 ${i} 单元`});
    }
  }
}
export async function demoInvoke(command:string,args:Record<string,unknown>,scenario:PreviewScenario):Promise<unknown> {
  initialize(scenario);
  const type=(args.request as {type?:string}|undefined)?.type;
  if(scenario==="slow")await new Promise(resolve=>setTimeout(resolve,1500));
  if(scenario==="error" && !["language","save_language","info"].includes(type||""))throw new Error("演示请求失败：切换完整数据后重试。");
  if(command==="read_asset" || command==="read_review_image") {
    if(scenario==="missing")throw new Error("演示资源缺失");
    const audio=args.hash===english.questions[0].audioRef?.sha256;
    if(command==="read_asset" && !audio && args.hash!==sample.visualElements[0].imageRef.sha256)throw new Error("未知演示资源");
    return (await fetch(audio ? audioUrl:imageUrl)).arrayBuffer();
  }
  let value:unknown;
  if(command==="request")value=request(args.request as Request,scenario);
  else if(command==="ai_request")value=aiRequest(args.request as AiRequest);
  else if(command==="office_request")value=type==="status" ? {path:"[演示]",version:"演示转换组件",capabilities:{writer_pdf:true,writer_text:true,calc_pdf:true,calc_text:true},errors:{}}:type==="convert" ? {paths:["[演示] 文档.pdf"],count:1}:null;
  else throw new Error(`开发预览未实现命令：${command}`);
  if(value===undefined)throw new Error(`开发预览未实现操作：${type}`);
  return structuredClone(value);
}
