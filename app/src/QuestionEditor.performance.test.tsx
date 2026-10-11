// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Profiler } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { blankQuestion, QuestionEditor } from "./QuestionEditor";

it.skipIf(!process.env.PRACTIQ_EDITOR_BENCH)("measures repeated edits of a large synthetic group", () => {
  const root = { ...blankQuestion(), id: "root", parentId: "", answerMode: "reading" as const, choiceVariant: null, options: [],
    stem: "Synthetic material", passage: [{ partType: "text" as const, textValue: "Source material. ".repeat(1250), jsonValue: { source: null, rows: [1,2,3] } }] };
  const children = Array.from({length:250}, (_,index) => ({ ...blankQuestion(), id: `child-${index}`, parentId:"root", answerMode: "true_false" as const, choiceVariant: null, options: [],
    stem: `Question ${index} ` + "Source evidence. ".repeat(50), answerPayload: { value:true },
    contentBlocks: Array.from({length:5}, (_,block) => ({partType:"text" as const,textValue:`Block ${block} `+"Evidence. ".repeat(40),jsonValue:{source:null,order:[index,block]}})) }));
  const input = JSON.stringify({root,children});
  const samples: { renderMs:number; inputToCommitMs:number }[] = [];
  for(let repetition=0;repetition<3;repetition++) {
    let duration = 0;
    render(<Profiler id="editor" onRender={(_,__,actualDuration)=>{duration+=actualDuration;}}><QuestionEditor initial={root} initialChildren={children} busy={false} onClose={vi.fn()} onSave={vi.fn()} /></Profiler>);
    const field = screen.getByRole("textbox",{name:"题干（支持 Markdown 和公式）"}) as HTMLTextAreaElement;
    for(let edit=0;edit<15;edit++) {
      const value = `${root.stem} ${edit}`;
      duration = 0;
      const start = performance.now();
      fireEvent.change(field,{target:{value}});
      samples.push({renderMs:duration,inputToCommitMs:performance.now()-start});
      expect(field.value).toBe(value);
    }
    cleanup();
  }
  writeFileSync(process.env.PRACTIQ_EDITOR_BENCH!,JSON.stringify({environment:{node:process.version,platform:process.platform,architecture:process.arch},inputSha256:createHash("sha256").update(input).digest("hex"),children:children.length,inputBytes:Buffer.byteLength(input),repetitions:3,edits:15,samples},null,2));
  writeFileSync(`${process.env.PRACTIQ_EDITOR_BENCH!}.input.json`,input);
});
