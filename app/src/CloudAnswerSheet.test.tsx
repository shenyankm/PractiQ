// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AnswerSheetMatcher } from "../../shared/cloud/AnswerSheetMatcher";
import { Client } from "../../shared/cloud/api";
import { setNativeBridge, type NativeBridge } from "../../shared/cloud/transport";
import { capabilities, task, question, newTaskId, runId } from "../../shared/cloud/test-fixtures";
beforeEach(()=>{localStorage.clear();globalThis.ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};});
afterEach(()=>{cleanup();setNativeBridge(null);vi.restoreAllMocks();localStorage.clear();});
it("selects answer sheets passively through native tickets and retries an uncertain create without another upload",async()=>{
 const document={fileName:"answers.txt",sizeBytes:4,sourceType:"text",mediaType:"text/plain",sha256:"a".repeat(64),objectKey:`practiq-agent/sources/${"a".repeat(64)}/source.txt`};
 const pickSources=vi.fn(async()=>[{nativeTicket:"answer-file-ticket",name:"answers.txt",size:4}]);
 const upload=vi.fn(async()=>document);
 const creations: Record<string,unknown>[]=[];
 const fetch=vi.fn(async(path:string,init:RequestInit)=>{
  if(path==="/api/import-capabilities")return Response.json(capabilities);
  if(path==="/api/document-tasks"&&init.method==="POST"){
   const request=JSON.parse(String(init.body));creations.push(request);
   if(creations.length===1)return Response.json({detail:{code:"TEMPORARY_BUSY"}},{status:503});
   return Response.json({threadId:newTaskId,runId,requestId:request.requestId,accepted:true});
  }
  if(path.startsWith("/api/document-tasks?"))return Response.json({items:[],hasMore:false});
  throw Error(`Unexpected cloud request: ${path}`);
 });
 setNativeBridge({origin:"https://cloud.test",pickSources,upload,fetch} as unknown as NativeBridge);
 render(<AnswerSheetMatcher task={task} questions={[question()]} client={new Client()} unavailable={false} onAssociate={vi.fn()}/>);
 const user=userEvent.setup();await user.click(screen.getByRole("button",{name:"选择答案卷文件"}));
 await screen.findByText("answers.txt");expect(upload).not.toHaveBeenCalled();expect(creations).toHaveLength(0);
expect(fetch.mock.calls.some(([,init])=>init.method==="POST")).toBe(false);
 await user.click(screen.getByRole("button",{name:"导入答案卷（将调用 AI）"}));
 await screen.findByRole("button",{name:"沿用原请求恢复答案卷导入"});
 await user.click(screen.getByRole("button",{name:"沿用原请求恢复答案卷导入"}));await screen.findByText(/答案卷任务已创建/);
 await waitFor(()=>expect(creations).toHaveLength(2));expect(creations[1]).toEqual(creations[0]);
 expect(creations[0]).toMatchObject({document,documentRole:"answers"});
 expect(creations[0].generateAnswers??false).toBe(false);expect(creations[0].deduplicateQuestions??false).toBe(false);
 expect(upload).toHaveBeenCalledExactlyOnceWith("answer-file-ticket");expect(pickSources).toHaveBeenCalledTimes(1);
 expect(fetch.mock.calls.some(([path])=>path.startsWith("/api/uploads"))).toBe(false);
});
