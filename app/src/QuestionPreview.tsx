import { list, t, useI18n } from "./i18n";
import { useState } from "react";
import { fieldName, type Question, type Group, type Visual } from "./api";
import { Content, Markdown } from "./Content";
import { AnswerDisplay } from "./AnswerInput";
import { Button } from "@/components/ui/button";

type PreviewGroup = Omit<Group,"id"|"questionIds"> & {id?:string;questionIds?:string[];questionIndexes?:number[]};
type PreviewVisual = Omit<Visual,"id"|"questionIds"> & {id?:string;questionIds?:string[];questionIndexes?:number[]};
export function QuestionPreview({ questions, groups = [], visuals = [] }: { questions: Question[]; groups?: PreviewGroup[]; visuals?: PreviewVisual[] }) {
  useI18n();
  const [page, setPage] = useState(0);
  const roots=questions.filter(q=>!q.parentId || !questions.some(p=>p.id===q.parentId));
  const rootId=(q:Question)=>{const seen=new Set<string>();while(q.parentId && !seen.has(q.parentId)){seen.add(q.parentId);const p=questions.find(p=>p.id===q.parentId);if(!p)break;q=p;}return q.id || `preview-${questions.indexOf(q)}`;};
  const current = Math.min(
    page,
    Math.max(0, Math.ceil(roots.length / 20) - 1),
  );
  return (
    <div className="space-y-4">
      {questions.filter(q=>roots.slice(current*20,current*20+20).some(r=>rootId(r)===rootId(q))).map((original) => {
        const i=questions.indexOf(original);const owner=original.optionSourceId ? questions.find(p=>p.id===original.optionSourceId) : undefined;
        const q=owner ? {...original,options:owner.options} : original;
        return (
        <article
          className="space-y-2 rounded border p-3"
          key={q.id || i}
        >
          <p>
            {i + 1}. {q.needsReview ? t("待复核") : ""}
          </p>
          <Content
            snapshot={{
              question: {
                ...q,
                contentBlocks: q.contentBlocks ?? [],
                missingFields: q.missingFields ?? [],
              },
              groups: groups.filter(g=>g.questionIds?.includes(q.id || "") || g.questionIndexes?.includes(i)).map((g,n)=>({...g,id:g.id || `section-${n}`,questionIds:g.questionIds || []})),
              visuals: visuals.filter(v=>(!v.questionIds?.length && !v.questionIndexes?.length) || v.questionIds?.includes(q.id || "") || v.questionIndexes?.includes(i)).map((v,n)=>({...v,id:v.id || `visual-${n}`,questionIds:v.questionIds || []})),
              sources: [],
              warnings: [],
              missingAssets: false,
            }}
          />
          {q.options?.map((o) => (
            <div key={o.label} className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-2 leading-[1.75]">
              <span className="min-w-6 font-medium">{o.label}.</span>
              <Markdown>{o.content}</Markdown>
            </div>
          ))}
          {q.items?.map((item, index) => (
            <div key={index}>
              <span>
                {item.side === "left" ? t("左侧") : item.side === "right" ? t("右侧") : t("题项")} {index + 1}
              </span>
              <Markdown>{item.content}</Markdown>
            </div>
          ))}
          <details>
            <summary>{t("答案、解析与来源")}</summary>
            <AnswerDisplay question={q} answer={q.answerPayload} />
            <Markdown>{q.analysis}</Markdown>
            <Markdown>{q.sourceText}</Markdown>
            <p>{list((q.missingFields || []).map(fieldName))}</p>
          </details>
        </article>
      );})}
      {roots.length > 20 && (
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={!current}
            onClick={() => setPage(current - 1)}
          >{t("前 20 题")}</Button>
          <span>
            {current + 1} / {Math.ceil(roots.length / 20)}
          </span>
          <Button
            variant="outline"
            disabled={(current + 1) * 20 >= roots.length}
            onClick={() => setPage(current + 1)}
          >{t("后 20 题")}</Button>
        </div>
      )}
    </div>
  );
}
