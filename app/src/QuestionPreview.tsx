import { ListeningPlayer } from "./ListeningPlayer";
import { list, t, useI18n } from "./i18n";
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fieldName, type Question, type Group, type Visual } from "./api";
import type { DocumentQualityIssue, DocumentQuestionSource } from "./contracts.generated";
import { Content, LazyDetails, Markdown } from "./Content";
import { AnswerDisplay } from "./AnswerInput";
import { materialLanguage } from "./english";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

type PreviewGroup = Omit<Group,"id"|"questionIds"> & {id?:string;questionIds?:string[];questionIndexes?:number[]};
type PreviewVisual = Omit<Visual,"id"|"questionIds"> & {id?:string;questionIds?:string[];questionIndexes?:number[]};
export function indexPreviewQuestions(questions: Question[]) {
  const byId = new Map<string, Question>();
  for (const q of questions) if (q.id && !byId.has(q.id)) byId.set(q.id, q);
  const roots = questions.filter(q => !q.parentId || !byId.has(q.parentId));
  const rootOf = new Map<Question, Question | undefined>();
  const trees = new Map(roots.map(q => [q, [] as { question: Question; index: number }[]]));
  questions.forEach((question, index) => {
    let current: Question | undefined = question;
    const path = new Set<Question>();
    while (current && !rootOf.has(current)) {
      if (path.has(current)) { current = undefined; break; }
      path.add(current);
      const parent: Question | undefined = current.parentId ? byId.get(current.parentId) : undefined;
      if (!parent) { rootOf.set(current, current); break; }
      current = parent;
    }
    const root = current ? rootOf.get(current) : undefined;
    for (const node of path) rootOf.set(node, root);
    if (root) trees.get(root)?.push({ question, index });
  });
  return { roots, trees, byId };
}

function qualityMessage(code: DocumentQualityIssue["code"]) {
  switch (code) {
    case "SOURCE_TEXT_NOT_FOUND": return t("未能在来源中定位原文，请核对题目与原文。");
    case "AMBIGUOUS_OVERLAP": return t("相邻片段可能包含重复题目，请核对。");
    case "OVERLAP_CONFLICT": return t("相邻片段的内容不一致，请对照原文确认。");
    case "MISSING_FIELDS": return t("题目信息不完整，请检查缺失字段。");
    case "NEEDS_REVIEW": return t("识别结果需要人工确认。");
  }
}

export const QuestionPreview = memo(function QuestionPreview({ questions, groups = [], visuals = [], reviewMode = false, reviewedQuestionIds = [], questionSources = [], qualityIssues = [], renderSource }: {
  questions: Question[];
  groups?: PreviewGroup[];
  visuals?: PreviewVisual[];
  reviewMode?: boolean;
  reviewedQuestionIds?: string[];
  questionSources?: DocumentQuestionSource[];
  qualityIssues?: DocumentQualityIssue[];
  renderSource?: (source: DocumentQuestionSource) => ReactNode;
}) {
  useI18n();
  const [page, setPage] = useState(0);
  const [onlyReview, setOnlyReview] = useState(reviewMode);
  const [focused, setFocused] = useState<number | null>(null);
  const articles = useRef(new Map<number, HTMLElement>());
  const { roots, trees, byId } = useMemo(() => indexPreviewQuestions(questions), [questions]);
  const reviewIds = new Set(qualityIssues.map(issue => issue.questionId));
  const reviewedIds = new Set(reviewedQuestionIds);
  const needsReview = (question: Question) => !reviewedIds.has(question.id || "") && (question.needsReview || reviewIds.has(question.id || ""));
  const reviewQuestions = questions.map((question, index) => ({ question, index })).filter(({ question }) => needsReview(question));
  const reviewRoots = roots.filter(root => trees.get(root)?.some(({ question }) => needsReview(question)));
  const visibleRoots = reviewMode && onlyReview && reviewRoots.length ? reviewRoots : roots;
  const current = Math.min(
    page,
    Math.max(0, Math.ceil(visibleRoots.length / 20) - 1),
  );
  useEffect(() => {
    if (focused == null) return;
    const article = articles.current.get(focused);
    article?.focus();
    article?.scrollIntoView?.({ block: "nearest" });
  }, [focused, current]);
  function nextReview() {
    const next = reviewQuestions.find(({ index }) => index > (focused ?? -1)) ?? reviewQuestions[0];
    if (!next) return;
    const rootIndex = visibleRoots.findIndex(root => trees.get(root)?.some(({ index }) => index === next.index));
    setPage(Math.floor(Math.max(0, rootIndex) / 20));
    setFocused(next.index);
    if (next.index === focused) {
      articles.current.get(next.index)?.focus();
      articles.current.get(next.index)?.scrollIntoView?.({ block: "nearest" });
    }
  }
  return (
    <div className="space-y-4">
      {reviewMode && <div className="flex flex-wrap items-center gap-3 rounded border bg-muted/30 p-3 text-sm">
        <p>{t("待复核 {0} 项；材料题会保留关联内容。", { 0: reviewQuestions.length })}</p>
        {reviewQuestions.length > 0 && <><label className="flex items-center gap-2"><Checkbox checked={onlyReview} onCheckedChange={checked => { setOnlyReview(checked === true); setPage(0); }}/>{t("仅看待复核")}</label><Button size="sm" variant="outline" onClick={nextReview}>{t("下一个待复核问题")}</Button></>}
      </div>}
      {visibleRoots.slice(current * 20, current * 20 + 20).flatMap(root => trees.get(root)!).sort((a, b) => a.index - b.index).map(({ question: original, index: i }) => {
        const owner = original.optionSourceId ? byId.get(original.optionSourceId) : undefined;
        const q=owner ? {...original,options:owner.options} : original;
        return (
        <article
          className="space-y-2 rounded border p-3"
          key={q.id || i}
          tabIndex={-1}
          aria-label={t("预览题目 {0}", { 0: i + 1 })}
          ref={element => { if (element) articles.current.set(i, element); else articles.current.delete(i); }}
        >
          <p>
            {i + 1}. {reviewedIds.has(q.id || "") ? t("已复核") : needsReview(q) ? t("待复核") : ""}
          </p>
          {reviewMode && <div className="space-y-2 text-sm">
            {qualityIssues.filter(issue => issue.questionId === q.id).map((issue, index) => <p key={index}>{qualityMessage(issue.code)}</p>)}
            {!!q.missingFields?.length && <p>{t("缺失：{0}", { 0: list(q.missingFields.map(fieldName)) })}</p>}
            {questionSources.filter(source => source.questionId === q.id).map((source, index) => <div key={index}>
              <p>{source.stage === "vision_parse" ? t("来源：第 {0} 页", { 0: source.unitIndex + 1 }) : t("来源：文本片段 {0}", { 0: source.unitIndex + 1 })}</p>
              {renderSource?.(source)}
            </div>)}
          </div>}
          <Content
            reviewed={reviewedIds.has(q.id || "")}
            snapshot={{
              question: {
                ...q,
                contentBlocks: q.contentBlocks ?? [],
                missingFields: q.missingFields ?? [],
              },
              groups: groups.filter(g=>g.questionIds?.includes(q.id || "") || g.questionIndexes?.includes(i)).map((g,n)=>({...g,id:g.id || `section-${n}`,questionIds:g.questionIds || []})),
              visuals: visuals.filter(v=>(!v.questionIds?.length && !v.questionIndexes?.length) || v.questionIds?.includes(q.id || "") || v.questionIndexes?.includes(i)).map((v,n)=>({...v,id:v.id || `visual-${n}`,questionIds:v.questionIds || []})),
              sources: questionSources.filter(source => source.questionId === q.id),
              warnings: [],
              missingAssets: false,
            }}
          />
          {q.answerMode === "listening" && <ListeningPlayer question={q}/>}
          {q.options?.map((o) => (
            <div key={o.label} className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-2 leading-[1.75]">
              <span className="min-w-6 font-medium">{o.label}.</span>
              <Markdown lang={materialLanguage(q)}>{o.content}</Markdown>
            </div>
          ))}
          {q.items?.map((item, index) => (
            <div key={index}>
              <span>
                {item.side === "left" ? t("左侧") : item.side === "right" ? t("右侧") : t("题项")} {index + 1}
              </span>
              <Markdown lang={materialLanguage(q)}>{item.content}</Markdown>
            </div>
          ))}
          <LazyDetails summary={t("答案、解析与来源")}>
            <AnswerDisplay question={q} answer={q.answerPayload} />
            <Markdown>{q.analysis}</Markdown>
            <Markdown>{q.sourceText}</Markdown>
            <p>{list((q.missingFields || []).map(fieldName))}</p>
          </LazyDetails>
        </article>
      );})}
      {visibleRoots.length > 20 && (
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={!current}
            onClick={() => setPage(current - 1)}
          >{t("前 20 题")}</Button>
          <span>
            {current + 1} / {Math.ceil(visibleRoots.length / 20)}
          </span>
          <Button
            variant="outline"
            disabled={(current + 1) * 20 >= visibleRoots.length}
            onClick={() => setPage(current + 1)}
          >{t("后 20 题")}</Button>
        </div>
      )}
    </div>
  );
});
