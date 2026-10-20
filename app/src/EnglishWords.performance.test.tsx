// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { AnswerInput } from "./AnswerInput";
import { countEnglishWords } from "./english";
import type { Question } from "./api";
import fixture from "../fixtures/english.json";

it.skipIf(!process.env.PRACTIQ_WORDS_BENCH)("measures word counting and writing answer rendering",()=>{
  const workloads = [];
  for (const count of [20,20000]) {
    const text = "alpha ".repeat(count);
    const question: Question = {...fixture.questions.find(q=>q.id==="write") as Question,minWords:10,maxWords:20000};
    const input = JSON.stringify({question,text});
    const row = {words:count,characters:text.length,inputSha256:createHash("sha256").update(input).digest("hex"),operations:{} as Record<string,unknown>};
    for (const operation of ["count","writingRender"] as const) {
      const samplesMs = [];
      let output: string | number = "";
      for(let sample=0;sample<8;sample++) {
        const start = performance.now();
        for(let repeat=0;repeat<20;repeat++) output = operation==="count" ? countEnglishWords(text) : renderToStaticMarkup(<AnswerInput question={question} value={{text}} onChange={()=>{}}/>);
        if(sample) samplesMs.push((performance.now()-start)/20);
      }
      if(operation==="count") expect(output).toBe(count);
      else expect(output).toContain(`当前 ${count.toLocaleString("en-US")} 词`);
      expect(JSON.stringify({question,text})).toBe(input);
      row.operations[operation] = {samplesMs,outputSha256:createHash("sha256").update(String(output)).digest("hex")};
    }
    workloads.push(row);
  }
  writeFileSync(process.env.PRACTIQ_WORDS_BENCH!,JSON.stringify({scope:"Local count kernel and complete React static writing-answer markup; one warmup and seven samples of twenty calls/renders. Excludes browser layout, keyboard/IPC and devices.",workloads},null,2));
});
