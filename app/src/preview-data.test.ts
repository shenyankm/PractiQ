import { beforeEach, expect, it, vi } from "vitest";
import { canInteract, type Bank, type PaperPreview, type Question, type QuestionPage, type QuestionRow, type Session, type SessionPage, type SettingsResult } from "./api";
import composite from "../fixtures/composite.json";
import sample from "../fixtures/sample.json";
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

it("keeps favorite search tied to the same original node",async()=>{
 const scope={...query,bank_ids:["preview-bank-1"],mode:"word_bank",filter:"favorite"};
 const result=await call<QuestionPage>(scope);
 expect(result.items.map(row=>row.id)).toEqual(["1-words"]);
 expect(result.items[0].favorite).toBe(true);
 expect((await call<QuestionPage>({...scope,search:"Complete the passage"})).total).toBe(0);
 expect((await call<QuestionPage>({...scope,search:"Choose the word for gap 1"})).items.map(row=>row.id)).toEqual(["1-words"]);
 await call({type:"favorite",id:"1-words",value:true});
 expect((await call<QuestionPage>({...scope,search:"Complete the passage"})).total).toBe(1);
});

it("sets and clears favorites for a complete nested composite subtree",async()=>{
 const scope={...query,bank_ids:["preview-bank-2"],mode:"reading"};
 const root=(await call<QuestionPage>(scope)).items[0];
 await call({type:"favorite",id:root.id,value:false});
 expect((await call<QuestionPage>({...scope,filter:"favorite"})).total).toBe(0);
 const cleared=(await call<QuestionPage>(scope)).items[0];
 expect([cleared,...cleared.children!].every(row=>!row.favorite)).toBe(true);
 await call({type:"favorite",id:root.id,value:true});
 const selected=(await call<QuestionPage>({...scope,filter:"favorite"})).items[0];
 expect([selected,...selected.children!].every(row=>row.favorite)).toBe(true);
});

it("keeps merged standalone roots and review confirmations isolated",async()=>{
 const added=await call<{bankId:string}>({type:"add_example_bank"});
 const merged=await call<{bankId:string}>({type:"merge_banks",bank_ids:["preview-bank-0",added.bankId],title:"Merged samples"});
 const scope={...query,bank_ids:[merged.bankId]};
 const result=await call<QuestionPage>(scope);
 expect(result.items).toHaveLength(18);
 expect(result.items.every(row=>row.answerableCount===1 && row.children?.length===0)).toBe(true);
 const duplicates=result.items.filter(row=>row.question.stem==="观察 PractiQ 图标，描述你的印象。");
 expect(duplicates).toHaveLength(2);
 await call({type:"review_question",id:duplicates[0].id,reviewed:true});
 expect((await call<QuestionPage>({...scope,filter:"review"})).items.map(row=>row.id)).toEqual([duplicates[1].id]);
 expect((await call<QuestionPage>(scope)).items.find(row=>row.id===duplicates[1].id)?.reviewedAt).toBe(duplicates[1].reviewedAt);
});

it("merges fresh review and practice state while preserving favorites and imported flags",async()=>{
 const at=await call<number>({type:"review_question",id:"0-q8",reviewed:true});
 await call({type:"favorite",id:"0-q8",value:true});
 const source=(await call<QuestionPage>({...query,bank_ids:["preview-bank-0"]})).items.find(row=>row.id==="0-q8")!;
 expect(source).toMatchObject({reviewedAt:at,latestResult:false,favorite:true,question:{needsReview:true}});
 const other=await call<{bankId:string}>({type:"add_example_bank"});
 const merged=await call<{bankId:string}>({type:"merge_banks",bank_ids:["preview-bank-0",other.bankId],title:"Fresh merged copies"});
 const scope={...query,bank_ids:[merged.bankId]};
 const copies=(await call<QuestionPage>(scope)).items;
 const copied=copies.find(row=>row.question.stem===source.question.stem)!;
 expect(copied).toMatchObject({reviewedAt:null,latestResult:null,latestScore:null,favorite:true,question:{needsReview:true},warnings:source.warnings});
 expect((await call<QuestionPage>({...scope,filter:"review"})).total).toBe(2);
 expect((await call<QuestionPage>({...scope,filter:"wrong"})).total).toBe(0);
 expect((await call<QuestionPage>({...scope,filter:"unattempted"})).total).toBe(18);
 expect(copies.every(row=>row.reviewedAt===null && row.latestResult===null && row.latestScore===null)).toBe(true);
 expect((await call<QuestionPage>({...query,bank_ids:["preview-bank-0"]})).items.find(row=>row.id===source.id)).toEqual(source);
});

it("preserves the full material ancestor chain in papers and immutable practice snapshots",async()=>{
 const paper=await call<PaperPreview>({type:"preview_paper",request:{bank_ids:["preview-bank-2"],search:"",mode:"reading",filter:"",selection:"manual",question_ids:["2-reading"],count:6,quotas:{},random:false,total_cents:0}});
 const leaf=paper.questions.find(row=>row.id==="2-words1")!;
 expect(leaf.materials?.map(q=>q.id)).toEqual(["reading","words"]);
 expect(paper.questions.find(row=>row.id==="2-r-choice")?.materials?.map(q=>q.id)).toEqual(["reading"]);
 const session=await call<Session>({type:"start_paper",paper:{question_ids:paper.questionIds,kind:"practice",minutes:null,scores:paper.scores,total_cents:0,digest:paper.digest}});
 const snapshot=session.attempts.find(attempt=>attempt.snapshot.id===leaf.id)!.snapshot;
 expect(snapshot.materials).toEqual(leaf.materials);
 expect(snapshot).toMatchObject({rootId:"2-reading",rootType:"reading"});
 const questions=structuredClone(composite.questions) as Question[];
 questions.find(q=>q.id==="reading")!.stem="Edited outer material";
 await call({type:"save_question_tree",root_id:"2-reading",bank_id:"preview-bank-2",questions});
 const resumed=await call<Session>({type:"session",id:session.id});
 expect(resumed.attempts.find(attempt=>attempt.snapshot.id===leaf.id)?.snapshot.materials).toEqual(snapshot.materials);
});

it("hydrates shared options for paper questions and immutable choice snapshots",async()=>{
 const paper=await call<PaperPreview>({type:"preview_paper",request:{bank_ids:["preview-bank-2"],search:"",mode:"reading",filter:"",selection:"manual",question_ids:["2-reading"],count:6,quotas:{},random:false,total_cents:0}});
 const leaf=paper.questions.find(row=>row.id==="2-words1")!;
 const owner=composite.questions.find(q=>q.id==="words")!;
 expect(leaf.question.options).toEqual(owner.options);
 expect(canInteract(leaf.question)).toBe(true);
 const session=await call<Session>({type:"start_paper",paper:{question_ids:paper.questionIds,kind:"practice",minutes:null,scores:paper.scores,total_cents:0,digest:paper.digest}});
 const attempt=session.attempts.find(a=>a.snapshot.id===leaf.id)!;
 expect(attempt.snapshot.question.options).toEqual(owner.options);
 expect(canInteract(attempt.snapshot.question)).toBe(true);
 const submitted=await call<Session>({type:"save_attempt",id:session.id,ordinal:attempt.ordinal,answer:{correct:["A"]},elapsed_ms:0,skip:false,submit:true,self_result:null});
 expect(submitted.attempts[attempt.ordinal]).toMatchObject({autoResult:true,result:true,gradeKind:"auto"});
 const questions=structuredClone(composite.questions) as Question[];
 questions.find(q=>q.id==="words")!.options[0].content="Edited option";
 await call({type:"save_question_tree",root_id:"2-reading",bank_id:"preview-bank-2",questions});
 const resumed=await call<Session>({type:"session",id:session.id});
 expect(resumed.attempts[attempt.ordinal].snapshot.question.options).toEqual(owner.options);
});

function materialRows():QuestionRow[] {
 return structuredClone(composite.questions.filter(q=>["reading","words","words1"].includes(q.id))).map(question=>({id:`2-${question.id}`,bankId:"preview-bank-2",bankTitle:"Materials",question:question as Question,groups:[],visuals:[],sources:[],warnings:[],missingAssets:false,favorite:false,latestResult:null}));
}

it("filters only ancestor passage answer roles and keeps source content and own answers intact",async()=>{
 const questions=structuredClone(composite.questions) as Question[];
 const roles=["ANSWER key","worked analysis","Solution","Explanation","Rubric","transcript","听力原文","答案","解析","解答","评分"];
 const parent=questions.find(q=>q.id==="reading")!;
 parent.passage=[{partType:"text",role:"prompt",textValue:"Visible material"},...roles.map(role=>({partType:"text" as const,role,textValue:`Hidden ${role}`}))];
 const own=questions.find(q=>q.id==="words1")!;
 own.passage=[{partType:"text",role:"answer",textValue:"Own raw answer block"}];
 const source=structuredClone(questions);
 await call({type:"save_question_tree",root_id:"2-reading",bank_id:"preview-bank-2",questions});
 const paper=await call<PaperPreview>({type:"preview_paper",request:{bank_ids:["preview-bank-2"],search:"",mode:"reading",filter:"",selection:"manual",question_ids:["reading"],count:6,quotas:{},random:false,total_cents:0}});
 const leaf=paper.questions.find(row=>row.id==="words1")!;
 expect(leaf.materials?.[0].passage).toEqual([parent.passage[0]]);
 expect(leaf.materials?.[0].analysis).toBe(parent.analysis);
 expect(leaf.question).toMatchObject({passage:own.passage,answerPayload:own.answerPayload});
 const session=await call<Session>({type:"start_paper",paper:{question_ids:paper.questionIds,kind:"practice",minutes:null,scores:paper.scores,total_cents:0,digest:paper.digest}});
 expect(session.attempts.find(a=>a.snapshot.id===leaf.id)?.snapshot).toMatchObject({materials:leaf.materials,rootId:"reading",rootType:"reading"});
 const stored=(await call<QuestionPage>({...query,bank_ids:["preview-bank-2"],mode:"reading"})).items[0];
 expect(stored.question.passage).toEqual(parent.passage);
 expect(questions).toEqual(source);
});

it("inherits ancestor contexts in child-first order with isolated copies and root metadata",async()=>{
 const items=materialRows(),[root,parent,leaf]=items;
 root.groups=[{id:"shared",title:"Outer duplicate",questionIds:[root.question.id!]},{id:"outer",title:"Outer",questionIds:[root.question.id!]}];
 parent.groups=[{id:"shared",title:"Near duplicate",questionIds:[parent.question.id!]},{id:"near",title:"Near",questionIds:[parent.question.id!]}];
 leaf.groups=[{id:"shared",title:"Child wins",questionIds:[leaf.question.id!]}];
 root.visuals=[{id:"same",kind:"image",description:"Outer duplicate",questionIds:[]},{id:"outer",kind:"image",description:"Outer",questionIds:[]}];
 parent.visuals=[{id:"same",kind:"image",description:"Near wins",questionIds:[]},{id:"near",kind:"image",description:"Near",questionIds:[]}];
 leaf.visuals=[{id:"child",kind:"image",description:"Child",questionIds:[leaf.question.id!]}];
 root.missingAssets=true;root.sources=[{fileName:"outer.pdf"}];root.warnings=["Outer warning"];root.favorite=true;root.reviewedAt=1;
 leaf.sources=[{fileName:"leaf.pdf"}];leaf.warnings=["Own warning"];leaf.reviewedAt=2;
 const source=structuredClone(items);
 const {hydrateQuestion}=await import("./preview-data");
 const result=hydrateQuestion(leaf,items);
 expect(result.groups.map(g=>[g.id,g.title])).toEqual([["shared","Child wins"],["near","Near"],["outer","Outer"]]);
 expect(result.visuals.map(v=>[v.id,v.description])).toEqual([["child","Child"],["same","Near wins"],["near","Near"],["outer","Outer"]]);
 expect(result).toMatchObject({missingAssets:true,rootId:root.id,rootType:"reading",sources:leaf.sources,warnings:leaf.warnings,favorite:false,reviewedAt:2});
 expect(result.materials?.map(q=>q.id)).toEqual(["reading","words"]);
 result.groups[0].title="Edited copy";result.visuals[1].description="Edited copy";result.question.options[0].content="Edited copy";result.materials![0].stem="Edited copy";
 expect(items).toEqual(source);
});

it.each(["material","media","options"] as const)("propagates the ancestor %s quality gap without changing own flags",async(field)=>{
 const items=materialRows(),leaf=items[2];items[1].question.missingFields=[field];
 const {hydrateQuestion}=await import("./preview-data");
 expect(hydrateQuestion(leaf,items)).toMatchObject({missingAssets:true,question:{missingFields:leaf.question.missingFields,needsReview:leaf.question.needsReview}});
 items[1].question.missingFields=["answerPayload"];
 expect(hydrateQuestion(leaf,items).missingAssets).toBe(false);
});

it("handles missing parents and cyclic material references with native root projections",async()=>{
 const items=materialRows(),[root,parent,leaf]=items;
 const {hydrateQuestion}=await import("./preview-data");
 root.question.parentId="absent";
 expect(hydrateQuestion(leaf,items)).toMatchObject({missingAssets:true,rootId:root.id,rootType:"reading"});
 root.question.parentId=parent.question.id;
 const cyclic=hydrateQuestion(leaf,items);
 expect(cyclic.materials?.map(q=>q.id)).toEqual(["reading","words"]);
 expect(cyclic).toMatchObject({missingAssets:false,rootId:parent.id,rootType:"word_bank"});
 const foreign=structuredClone(root);foreign.bankId="other-bank";foreign.question.parentId=null;
 expect(hydrateQuestion(leaf,[leaf,foreign])).toMatchObject({missingAssets:true,rootId:leaf.id,rootType:"single"});
 const standalone=structuredClone(leaf);standalone.question.parentId=null;standalone.question.optionSourceId=null;
 expect(hydrateQuestion(standalone,[standalone])).toMatchObject({rootId:standalone.id,rootType:"single",materials:[]});
 for(const [question,rootType] of [[{...standalone.question,questionKind:"translation"},"translation"],[{...standalone.question,answerMode:"gap_fill"},"grammar_fill"],[{...standalone.question,choiceVariant:"multiple"},"multiple"],[{...standalone.question,answerMode:null},""]] as const) {
  const row={...standalone,question:question as Question};
  expect(hydrateQuestion(row,[row]).rootType).toBe(rootType);
 }
 standalone.question.parentId=standalone.question.id;
 expect(hydrateQuestion(standalone,[standalone]).materials?.map(q=>q.id)).toEqual([standalone.question.id]);
});

it("keeps context identity and global visual scope isolated across merged banks",async()=>{
 const fixture=structuredClone(sample);
 fixture.groups.push({...fixture.groups[0],title:"Another group",questionIds:["q1","q2"]});
 fixture.visualElements.push({...fixture.visualElements[0],description:"Global visual",questionIds:[]});
 fixture.visualElements.push({...fixture.visualElements[0],description:"Document-only visual",documentOnly:true} as typeof fixture.visualElements[number]);
 vi.doMock("../fixtures/sample.json",()=>({default:fixture}));
 try {
  const source=(await call<QuestionPage>({...query,bank_ids:["preview-bank-0"]})).items;
  expect(source.every(row=>row.visuals.some(v=>v.description==="Global visual"))).toBe(true);
  expect(source.every(row=>row.visuals.every(v=>v.description!=="Document-only visual"))).toBe(true);
  expect(source.find(row=>row.id==="0-q1")!.groups.map(g=>g.id)).toEqual(["group-0","group-1"]);
  expect(source.find(row=>row.id==="0-q2")!.groups.map(g=>g.id)).toEqual(["group-0","group-1"]);
  const other=await call<{bankId:string}>({type:"add_example_bank"});
  const merged=await call<{bankId:string}>({type:"merge_banks",bank_ids:["preview-bank-0",other.bankId],title:"Context copies"});
  const copied=(await call<QuestionPage>({...query,bank_ids:[merged.bankId]})).items;
  const halves=[copied.slice(0,9),copied.slice(9)];
  for(const half of halves) {
   const ids=half.map(row=>row.question.id);
   const globals=half.map(row=>row.visuals.find(v=>v.description==="Global visual")!);
   expect(new Set(globals.map(v=>v.id)).size).toBe(1);
   expect(globals.every(v=>JSON.stringify(v.questionIds)===JSON.stringify(ids))).toBe(true);
   expect(new Set(half.flatMap(row=>row.groups.map(g=>g.id))).size).toBe(2);
  }
  for(const key of ["groups","visuals"] as const) {
   const firstIds=new Set(halves[0].flatMap(row=>row[key].map(c=>c.id)));
   expect(halves[1].every(row=>row[key].every(c=>!firstIds.has(c.id)))).toBe(true);
  }
  expect((await call<QuestionPage>({...query,bank_ids:["preview-bank-0"]})).items).toEqual(source);
 } finally {vi.doUnmock("../fixtures/sample.json");}
});

it("remaps merged composite copies and keeps their descendants and option owners isolated",async()=>{
 const other=await call<string>({type:"save_bank",id:null,title:"Other composite",description:""});
 const questions=structuredClone(composite.questions) as Question[];
 questions.find(q=>q.id==="reading")!.stem="Other reading material";
 questions.find(q=>q.id==="words")!.options[0].content="Other option";
 await call({type:"save_question_tree",root_id:"reading",bank_id:other,questions});
 const merged=await call<{bankId:string;count:number}>({type:"merge_banks",bank_ids:["preview-bank-2",other],title:"Merged composite copies"});
 const scope={...query,bank_ids:[merged.bankId],mode:"reading"};
 const roots=(await call<QuestionPage>(scope)).items;
 expect(roots).toHaveLength(2);
 expect(roots.map(root=>root.children?.length)).toEqual([8,8]);
 expect(roots.map(root=>root.answerableCount)).toEqual([6,6]);
 expect(merged.count).toBe(20);
 const nodes=roots.flatMap(root=>[root,...root.children!]);
 expect(new Set(nodes.map(row=>row.question.id)).size).toBe(nodes.length);
 expect(nodes.every(row=>row.id===row.question.id)).toBe(true);
 const first=roots[0],second=roots[1];
 const secondIds=new Set([second,...second.children!].map(row=>row.question.id));
 expect(second.children!.every(row=>secondIds.has(row.question.parentId))).toBe(true);
 const words=second.children!.find(row=>row.question.answerMode==="word_bank")!;
 expect(words.question.passage?.filter(block=>block.questionId).map(block=>block.questionId)).toEqual(second.children!.filter(row=>row.question.parentId===words.question.id).map(row=>row.question.id));
 const paper=await call<PaperPreview>({type:"preview_paper",request:{bank_ids:[merged.bankId],search:"",mode:"reading",filter:"",selection:"manual",question_ids:[second.id],count:6,quotas:{},random:false,total_cents:0}});
 expect(paper.count).toBe(6);
 const leaf=paper.questions.find(row=>row.question.optionSourceId===words.question.id)!;
 expect(leaf.materials?.map(q=>q.id)).toEqual([second.question.id,words.question.id]);
 expect(leaf.materials?.[0].stem).toBe("Other reading material");
 expect(leaf.question.options[0].content).toBe("Other option");
 const session=await call<Session>({type:"start_paper",paper:{question_ids:paper.questionIds,kind:"practice",minutes:null,scores:paper.scores,total_cents:0,digest:paper.digest}});
 expect(session.attempts.find(a=>a.snapshot.id===leaf.id)?.snapshot).toMatchObject({question:leaf.question,materials:leaf.materials});
 await call({type:"favorite",id:second.id,value:false});
 await call({type:"review_question",id:second.id,reviewed:true});
 const unchanged=(await call<QuestionPage>(scope)).items.find(root=>root.id===first.id)!;
 expect(unchanged).toEqual(first);
 expect((await call<QuestionPage>({...query,bank_ids:["preview-bank-2"],mode:"reading"})).items[0].id).toBe("2-reading");
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
