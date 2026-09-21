// @vitest-environment jsdom
import { Profiler } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Practice } from "./Practice";
import { Content, Markdown } from "./Content";
import type { Question, Session, Snapshot } from "./api";
import fixture from "../fixtures/sample.json";
vi.mock("./api",async()=>({...await vi.importActual("./api"),api:vi.fn().mockResolvedValue(null)}));
afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();});
const snapshot:Snapshot={question:fixture.questions[2] as Question,groups:[],visuals:[{id:"v",kind:"image",description:"Figure",questionIds:["q"],sourceRef:{sha256:"a".repeat(64),objectKey:"page",mediaType:"image/png",sizeBytes:1}}],sources:[],warnings:[],missingAssets:false};
function session(submitted:boolean):Session {
  return {id:"test",title:"Review",createdAt:0,finishedAt:submitted?1:null,position:0,mode:"ordered",kind:"practice",attempts:[{ordinal:0,snapshot,answer:null,autoResult:null,result:null,gradeKind:"ungraded",submittedAt:submitted?1:null,skipped:false,elapsedMs:0}]};
}
it("hides original pages before practice submission and stops history clock renders",async()=>{
  vi.useFakeTimers();
  const onRender=vi.fn();
  const props={run:vi.fn(),onSession:vi.fn(),flushRef:{current:async()=>{}}};
  const view=render(<Profiler id="practice" onRender={onRender}><Practice session={session(false)} {...props}/></Profiler>);
  expect(screen.queryByRole("button",{name:"查看原页"})).toBeNull();
  view.rerender(<Profiler id="practice" onRender={onRender}><Practice session={session(true)} {...props}/></Profiler>);
  expect(screen.getByRole("button",{name:"查看原页"})).toBeTruthy();
  onRender.mockClear();
  await act(async()=>{await vi.advanceTimersByTimeAsync(3000);});
  expect(onRender).not.toHaveBeenCalled();
});
it("renders inherited JSON blocks and literal table syntax without activating HTML",()=>{
  render(<Content snapshot={{...snapshot,visuals:[],groups:[{id:"g",title:"Material",questionIds:["q"],contentBlocks:[{partType:"table",jsonValue:{cells:[["inherited-cell"]]}}]}]}}/>);
  expect(screen.getByText(/inherited-cell/)).toBeTruthy();
  const {container}=render(<Markdown>{"| literal | math |\n| --- | --- |\n| &#91;A&#93;&#40;B&#41; &#60;tag&#62; &#33;&#91;x&#93;&#40;y&#41; | $x^2$ |"}</Markdown>);
  expect(container.textContent).toContain("[A](B) <tag> ![x](y)");
  expect(container.querySelector("tag,img,a")).toBeNull();
  expect(container.querySelector(".katex")).not.toBeNull();
});
