import { useState } from "react";
import { type Question } from "./api";
import { Content, Markdown } from "./Content";
import { AnswerDisplay } from "./AnswerInput";
import { Button } from "@/components/ui/button";

export function QuestionPreview({ questions }: { questions: Question[] }) {
  const [page, setPage] = useState(0);
  const current = Math.min(
    page,
    Math.max(0, Math.ceil(questions.length / 20) - 1),
  );
  return (
    <div className="space-y-4">
      {questions.slice(current * 20, current * 20 + 20).map((q, i) => (
        <article
          className="space-y-2 rounded border p-3"
          key={current * 20 + i}
        >
          <p>
            {current * 20 + i + 1}. {q.needsReview ? "待复核" : ""}
          </p>
          <Content
            snapshot={{
              question: {
                ...q,
                contentBlocks: q.contentBlocks ?? [],
                missingFields: q.missingFields ?? [],
              },
              groups: [],
              visuals: [],
              sources: [],
              warnings: [],
              missingAssets: false,
            }}
          />
          {q.options?.map((o) => (
            <div key={o.label}>
              <span>{o.label}.</span>
              <Markdown>{o.content}</Markdown>
            </div>
          ))}
          {q.items?.map((item, index) => (
            <div key={index}>
              <span>
                {item.side || "题项"} {index + 1}
              </span>
              <Markdown>{item.content}</Markdown>
            </div>
          ))}
          <details>
            <summary>答案、解析与来源</summary>
            <AnswerDisplay question={q} answer={q.answerPayload} />
            <Markdown>{q.analysis}</Markdown>
            <Markdown>{q.sourceText}</Markdown>
            <p>{q.missingFields?.join("、")}</p>
          </details>
        </article>
      ))}
      {questions.length > 20 && (
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={!current}
            onClick={() => setPage(current - 1)}
          >
            前 20 题
          </Button>
          <span>
            {current + 1} / {Math.ceil(questions.length / 20)}
          </span>
          <Button
            variant="outline"
            disabled={(current + 1) * 20 >= questions.length}
            onClick={() => setPage(current + 1)}
          >
            后 20 题
          </Button>
        </div>
      )}
    </div>
  );
}
