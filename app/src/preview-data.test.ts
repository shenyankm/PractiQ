import { beforeEach, expect, it, vi } from "vitest";
import type { Bank, Question, QuestionPage, Session, SessionPage, SettingsResult } from "./api";
import composite from "../fixtures/composite.json";
import type { Summary, Task } from "./ai-api";
import type { PreviewScenario } from "./preview-mode";
const mode=vi.hoisted(()=>({value:"normal" as PreviewScenario}));
vi.mock("./preview-mode",()=>({previewMode:()=>mode.value}));
vi.mock("@tauri-apps/api/core",()=>({invoke:vi.fn(()=>{throw new Error("Native IPC must not run");})}));
beforeEach(()=>{vi.resetModules();mode.value="normal";});
async function call<T>(request:Record<string,unknown>, command="request") {const {invoke}=await import("./transport");return invoke<T>(command,{request});}
const query={type:"questions_page",bank_ids:[],search:"",mode:"",filter:"",offset:0,limit:100};

it.each([
 ["single",["0-q0"]], ["multiple",["0-q1"]], ["choice",["0-q0","0-q1"]],
 ["translation",["1-translate"]], ["writing",["1-write"]], ["paragraph_matching",["1-match"]],
 ["sentence_selection",["1-sentences"]], ["grammar_fill",["1-grammar"]],
 ["short_answer",["0-q4","0-q8"]],
])("matches native root type filtering for %s",async(mode,ids)=>{
 const result=await call<QuestionPage>({...query,mode});
 expect(result.items.map(row=>row.id)).toEqual(ids);
 expect(result.total).toBe(ids.length);
 if(mode==="grammar_fill") {
  const stats=await call<{count:number;types:Record<string,number>}>({type:"question_stats",bank_ids:[],mode,filter:"",search:""});
  expect(stats).toMatchObject({count:1,types:{grammar_fill:1}});
  expect(result.items[0].children?.map(child=>child.id)).toEqual(["1-grammar-1"]);
 }
});

it("keeps imported warnings and quality flags when confirming or undoing review",async()=>{
 const initial=(await call<QuestionPage>({...query,filter:"review"})).items.find(row=>row.id==="0-q8")!;
 const at=await call<number>({type:"review_question",id:initial.id,reviewed:true});
 const confirmed=(await call<QuestionPage>(query)).items.find(row=>row.id===initial.id)!;
 expect(confirmed).toMatchObject({reviewedAt:at,question:initial.question,warnings:initial.warnings});
 expect(confirmed.question.needsReview).toBe(true);
 expect((await call<QuestionPage>({...query,filter:"review"})).items.map(row=>row.id)).not.toContain(initial.id);
 expect(await call({type:"review_question",id:initial.id,reviewed:false})).toBeNull();
 expect((await call<QuestionPage>({...query,filter:"review"})).items.find(row=>row.id===initial.id)).toMatchObject({reviewedAt:null,question:initial.question,warnings:initial.warnings});
});

it("filters and confirms the entire nested composite tree without changing imported flags",async()=>{
 const questions=structuredClone(composite.questions.filter(q=>!["words-root","words-root1","words-root2","cloze-root","cloze-root1","cloze-root2"].includes(q.id))) as Question[];
 questions.find(q=>q.id==="words1")!.needsReview=true;
 await call({type:"save_question_tree",root_id:"2-reading",bank_id:"preview-bank-2",questions});
 const scope={...query,bank_ids:["preview-bank-2"],filter:"review"};
 const root=(await call<QuestionPage>(scope)).items[0];
 expect(root.id).toBe("reading");
 expect(root.children?.map(row=>row.id)).toEqual(["r-choice","r-short","words","words1","words2","cloze","cloze1","cloze2"]);
 expect(root.answerableCount).toBe(6);
 const paper=await call<{count:number;questionIds:string[]}>({type:"preview_paper",request:{bank_ids:["preview-bank-2"],search:"",mode:"reading",filter:"review",selection:"manual",question_ids:[root.id],count:6,quotas:{},random:false,total_cents:0}});
 expect(paper).toMatchObject({count:6,questionIds:["r-choice","r-short","words1","words2","cloze1","cloze2"]});
 await expect(call({type:"review_question",id:"words1",reviewed:true})).rejects.toThrow("顶层题目");
 const at=await call<number>({type:"review_question",id:root.id,reviewed:true});
 expect((await call<QuestionPage>(scope)).total).toBe(0);
 const confirmed=(await call<QuestionPage>({...scope,filter:""})).items.find(row=>row.id===root.id)!;
 expect([confirmed,...confirmed.children!].every(row=>row.reviewedAt===at)).toBe(true);
 expect(confirmed.children?.find(row=>row.id==="words1")?.question.needsReview).toBe(true);
 await call({type:"review_question",id:root.id,reviewed:false});
 const undone=(await call<QuestionPage>(scope)).items[0];
 expect([undone,...undone.children!].every(row=>row.reviewedAt===null)).toBe(true);
});

it("provides every question mode, media, favorites, wrong answers and isolated editable data",async()=>{
 const banks=await call<Bank[]>({type:"banks"});expect(banks).toHaveLength(4);
 const query={type:"questions_page",bank_ids:[],search:"",mode:"",filter:"",offset:0,limit:100};
 const page=await call<QuestionPage>(query);
 expect(new Set(page.items.map(q=>q.question.answerMode))).toEqual(new Set(["choice","true_false","fill_blank","short_answer","ordering","matching","reading","word_bank","cloze","listening","gap_fill"]));
 expect(page.items.some(q=>q.visuals.length)).toBe(true);
 expect(page.items.some(q=>q.question.needsReview)).toBe(true);
 const selected=await call<QuestionPage>({...query,bank_ids:[banks[0].id]});
 expect(selected.items.length).toBeGreaterThan(0);
 expect(selected.items.every(q=>q.bankId===banks[0].id)).toBe(true);
 const combined=await call<QuestionPage>({...query,bank_ids:banks.slice(0,2).map(b=>b.id)});
 expect(new Set(combined.items.map(q=>q.bankId))).toEqual(new Set(banks.slice(0,2).map(b=>b.id)));
 expect((await call<QuestionPage>({...query,filter:"wrong"})).total).toBeGreaterThan(0);
 expect((await call<QuestionPage>({...query,filter:"favorite"})).total).toBeGreaterThan(0);
 await call({type:"favorite",id:page.items[0].id,value:false});
 expect((await call<QuestionPage>({...query,filter:"favorite"})).items.some(q=>q.id===page.items[0].id)).toBe(false);
 page.items[0].question.stem="mutated response";
 expect((await call<QuestionPage>(query)).items[0].question.stem).not.toBe("mutated response");
 await expect(call({type:"unsupported"})).rejects.toThrow("未实现操作");
});
it("previews history, snapshots, grading and import state transitions",async()=>{
 const history=await call<SessionPage>({type:"sessions_page",offset:0,limit:20});
 expect(history.items.map(s=>s.kind)).toContain("mock_exam");
 expect((await call<SessionPage>({type:"sessions_page",offset:0,limit:20,filter:"review"})).items).toHaveLength(2);
 const session=await call<Session>({type:"session",id:"preview-review"});
 const graded=await call<Session>({type:"grade",id:session.id,ordinal:4,retry:false},"ai_request");
 expect(graded.attempts[4].gradeKind).toBe("ai");
 expect(graded.attempts[4].grading?.ai?.result?.reason).toContain("未调用模型");
 const tasks=await call<{items:Summary[]}>({type:"list",offset:0},"ai_request");
 expect(new Set(tasks.items.map(t=>t.state)).size).toBe(10);
 await call({type:"control",id:"demo-001",action:"pause"},"ai_request");
 expect((await call<Task>({type:"get",id:"demo-001"},"ai_request")).state).toBe("PAUSED");
 await call({type:"control",id:"demo-001",action:"resume"},"ai_request");
 expect((await call<Task>({type:"get",id:"demo-001"},"ai_request")).state).toBe("RUNNING");
});
it("supports empty state creation and settings recovery",async()=>{
 mode.value="empty";
 expect(await call({type:"banks"})).toEqual([]);
 await call({type:"save_bank",id:null,title:"新题库",description:""});
 expect(await call<Bank[]>({type:"banks"})).toHaveLength(1);
 await call({type:"add_example_bank"});
 expect((await call<QuestionPage>({type:"questions_page",bank_ids:[],search:"",mode:"",filter:"",offset:0,limit:20})).total).toBe(9);
 vi.resetModules();mode.value="unconfigured";
 expect((await call<SettingsResult>({type:"settings"})).hasApiKey).toBe(false);
 await call({type:"save_settings",config:{base_url:"https://example.invalid",model_id:"demo"},api_key:"demo"});
 expect((await call<SettingsResult>({type:"settings"})).hasApiKey).toBe(true);
});
it("paginates large data and exposes failure and loading scenarios without native fallback",async()=>{
 mode.value="many";
 const a=await call<{items:Bank[];total:number}>({type:"banks_page",offset:0,limit:20});
 const b=await call<{items:Bank[]}>({type:"banks_page",offset:20,limit:20});
 expect(a.total).toBeGreaterThan(20);expect(b.items.length).toBeGreaterThan(0);
 expect(b.items.some(b=>a.items.some(a=>a.id===b.id))).toBe(false);
 mode.value="error";await expect(call({type:"backup"})).rejects.toThrow("演示请求失败");
 mode.value="missing";const {invoke}=await import("./transport");await expect(invoke("read_asset",{hash:"anything"})).rejects.toThrow("资源缺失");
 mode.value="slow";vi.useFakeTimers();try {const result=call({type:"banks"});await vi.advanceTimersByTimeAsync(1500);expect(await result).toBeTruthy();} finally {vi.useRealTimers();}
});
