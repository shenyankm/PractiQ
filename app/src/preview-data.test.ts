import { beforeEach, expect, it, vi } from "vitest";
import type { Bank, QuestionPage, Session, SessionPage, SettingsResult } from "./api";
import type { Summary, Task } from "./ai-api";
import type { PreviewScenario } from "./preview-mode";
const mode=vi.hoisted(()=>({value:"normal" as PreviewScenario}));
vi.mock("./preview-mode",()=>({previewMode:()=>mode.value}));
vi.mock("@tauri-apps/api/core",()=>({invoke:vi.fn(()=>{throw new Error("Native IPC must not run");})}));
beforeEach(()=>{vi.resetModules();mode.value="normal";});
async function call<T>(request:Record<string,unknown>, command="request") {const {invoke}=await import("./transport");return invoke<T>(command,{request});}

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
it("submits preview practice separately from self-assessment and preserves the answer",async()=>{
 const submitted=await call<Session>({type:"save_attempt",id:"preview-practice",ordinal:4,answer:{text:"My answer"},elapsed_ms:123,submit:true,skip:false});
 expect(submitted.attempts[4]).toMatchObject({answer:{text:"My answer"},elapsedMs:123,gradeKind:"ungraded",result:null,autoResult:null});
 expect(submitted.attempts[4].submittedAt).toBeGreaterThan(0);
 const assessed=await call<Session>({type:"self_assess",id:submitted.id,ordinal:4,result:false});
 expect(assessed.attempts[4]).toEqual({...submitted.attempts[4],result:false,gradeKind:"self"});
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
