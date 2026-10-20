// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { AnswerDisplay } from "./AnswerInput";
import { blankQuestion, type Answer, type Question } from "./api";

it.skipIf(!process.env.PRACTIQ_ANSWER_BENCH)("measures answer display with bounded item lists", () => {
  const workloads = [];
  for (const mode of ["ordering", "matching"] as const) {
    for (const count of [6, 100]) {
      const items = Array.from({length:count}, (_, i) => ({id: mode === "matching" ? i % (count / 2) : i, side: mode === "matching" ? (i < count / 2 ? "left" as const : "right" as const) : null, content:`Item ${i}`}));
      const question: Question = {...blankQuestion(), id:"synthetic", answerMode:mode, choiceVariant:null, options:[], items};
      const answer: Answer = mode === "ordering" ? {order:items.map(item => item.id)} : {matches:Array.from({length:count / 2}, (_, i) => ({left:i,right:i}))};
      const input = JSON.stringify({question,answer});
      const samplesMs = [];
      let output = "";
      for (let sample = 0; sample < 8; sample++) {
        const start = performance.now();
        for (let repeat = 0; repeat < 10; repeat++) output = renderToStaticMarkup(<AnswerDisplay question={question} answer={answer}/>);
        if (sample) samplesMs.push((performance.now() - start) / 10);
      }
      expect(output).toContain("Item 0");
      expect(output).toContain(`Item ${count - 1}`);
      expect(JSON.stringify({question,answer})).toBe(input);
      workloads.push({mode,count,samplesMs,inputSha256:createHash("sha256").update(input).digest("hex"),outputSha256:createHash("sha256").update(output).digest("hex")});
    }
  }
  writeFileSync(process.env.PRACTIQ_ANSWER_BENCH!, JSON.stringify({scope:"React static markup including Markdown; one warmup and seven samples of ten renders. Excludes browser layout, Tauri IPC and devices.",workloads}, null, 2));
});
