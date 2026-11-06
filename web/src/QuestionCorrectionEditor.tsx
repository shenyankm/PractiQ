import { useEffect, useRef, useState } from "react";
import type { ParsedQuestion } from "./contracts.generated";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Select, SelectOption } from "./components/ui/select";

type Props = { question: ParsedQuestion; saving: boolean; checking?: boolean; unconfirmed?: boolean; onSave: (question: ParsedQuestion) => Promise<void>; onCancel: () => void };
const labels = { choice: "选择题", true_false: "判断题", fill_blank: "填空题", short_answer: "简答题", ordering: "排序题", matching: "匹配题", reading: "阅读理解", word_bank: "选词填空", cloze: "完形填空", listening: "听力题", gap_fill: "语法填空" };
export default function QuestionCorrectionEditor({ question, saving, checking = false, unconfirmed = false, onSave, onCancel }: Props) {
  const firstField = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { firstField.current?.focus(); }, []);
  const [draft, setDraft] = useState(question);
  const [initialAnswer] = useState(() => {
    const a: Record<string, unknown> | null = question.answerPayload;
    if (!a) return "";
    if (Array.isArray(a.correct)) return a.correct.join("、");
    if (typeof a.value === "boolean") return String(a.value);
    if (Array.isArray(a.answers)) return a.answers.map(v => v ?? "").join("\n");
    if (typeof a.text === "string") return a.text;
    if (Array.isArray(a.order)) return a.order.join("、");
    if (Array.isArray(a.matches)) return a.matches.map((p: {left?: number; right?: number} | null) => `${p?.left ?? ""}=${p?.right ?? ""}`).join("\n");
    return "";
  });
  const [answer, setAnswer] = useState(initialAnswer);
  const [error, setError] = useState("");
  const composite = ["reading", "word_bank", "cloze", "listening", "gap_fill"].includes(draft.answerMode || "");
  const itemLabels = draft.answerMode === "matching"
    ? (["left", "right"] as const).flatMap(side => draft.items.filter(item => item.side === side).map((item,index) => `${side === "left" ? "左侧" : "右侧"} ${item.id ?? index} ${item.content ?? ""}`))
    : draft.items.map((item,index) => `${item.id ?? index} ${item.content ?? ""}`);
  const set = (values: Partial<ParsedQuestion>) => setDraft(previous => ({ ...previous, ...values }));
  const locked = saving || checking;
  const inputsLocked = locked || unconfirmed;
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (locked) return;
    setError("");
    try {
      let payload: ParsedQuestion["answerPayload"] = answer === initialAnswer && draft.answerMode === question.answerMode ? question.answerPayload : null;
      if ((answer !== initialAnswer || draft.answerMode !== question.answerMode) && answer.trim() && !composite) {
        if (draft.answerMode === "choice") payload = { correct: answer.split(/[、,，]/).map(v => v.trim()).filter(Boolean) };
        else if (draft.answerMode === "true_false") payload = { value: answer === "true" };
        else if (draft.answerMode === "fill_blank") payload = { answers: answer.split("\n").map(v => v.trim() || null) };
        else if (draft.answerMode === "short_answer") payload = { text: answer };
        else if (draft.answerMode === "ordering") {
          const order = answer.split(/[、,，]/).map(v => v.trim());
          if (order.some(v => !/^\d+$/.test(v))) throw Error("排序答案请填写非负题项编号，以逗号分隔。");
          payload = { order: order.map(Number) };
        } else if (draft.answerMode === "matching") {
          const pairs = answer.split("\n").map(v => v.trim().match(/^(\d+)\s*=\s*(\d+)$/));
          if (pairs.some(v => !v)) throw Error("匹配答案每行填写一组题项编号，例如 0=1。");
          payload = { matches: pairs.map(v => ({ left: Number(v![1]), right: Number(v![2]) })) };
        } else throw Error("请先选择作答方式，再填写参考答案。");
      }
      await onSave({ ...draft, blankCount: draft.answerMode === "fill_blank" && payload && "answers" in payload && Array.isArray(payload.answers) ? payload.answers.length : draft.blankCount, answerPayload: payload, needsReview: true });
    } catch (e) { setError(e instanceof Error ? e.message : "保存失败，修改仍保留，请重新读取修订后核对。"); }
  }
  return <form className="correction-editor" onSubmit={event => void submit(event)} aria-label="人工校对题目">
    <fieldset className="correction-editor" disabled={inputsLocked}>
    <p>修改单独保存；原始解析、来源证据和复核标记会保留。不会调用模型。</p>
    <label>题干<textarea ref={firstField} value={draft.stem ?? ""} maxLength={120000} onChange={e => set({ stem: e.target.value || null })} /></label>
    {!!draft.contentBlocks.length && <fieldset><legend>题干补充内容</legend><p>以下为解析出的内容块，请与题干一起核对；来源原文保持不变。</p>{draft.contentBlocks.map((block,index) => <div key={index}>{(["textValue", "markdownValue", "latexValue"] as const).filter(field => block[field] != null).map(field => <label key={field}>内容块 {index + 1} · {field === "latexValue" ? "公式" : field === "markdownValue" ? "排版文本" : "文本"}<textarea value={block[field] ?? ""} maxLength={field === "latexValue" ? 20000 : field === "markdownValue" ? 100000 : 120000} onChange={e => set({ contentBlocks: draft.contentBlocks.map((value,i) => i === index ? { ...value, [field]: e.target.value || null } : value) })} /></label>)}</div>)}</fieldset>}
    <div className="correction-fields"><label>题型标签<Input value={draft.questionTypeId ?? ""} maxLength={128} onChange={e => set({ questionTypeId: e.target.value || null })} /></label>
      <label>作答方式<Select disabled={inputsLocked || !!question.questionKind || !!question.passage?.length || !!question.transcript?.length || !!question.parentId || !!question.optionSourceId || composite} value={draft.answerMode ?? "unknown"} onValueChange={value => { set({ answerMode: value === "unknown" ? null : value as ParsedQuestion["answerMode"], questionKind: null, blankCount: null, choiceVariant: value === "choice" ? "single" : null, matchingVariant: value === "matching" ? "one_to_one" : null, options: ["choice", "word_bank"].includes(value) ? draft.options : [], items: ["matching", "ordering"].includes(value) ? draft.items : [] }); setAnswer(""); }}><SelectOption value="unknown">未确定</SelectOption>{Object.entries(labels).filter(([mode]) => !["reading", "word_bank", "cloze", "listening", "gap_fill"].includes(mode) || mode === draft.answerMode).map(([mode,label]) => <SelectOption key={mode} value={mode}>{label}</SelectOption>)}</Select></label></div>
    {draft.answerMode === "choice" && <label>选择方式<Select disabled={inputsLocked} value={draft.choiceVariant ?? "single"} onValueChange={value => set({ choiceVariant: value as "single" | "multiple" })}><SelectOption value="single">单选</SelectOption><SelectOption value="multiple">多选</SelectOption></Select></label>}
    {(["choice", "word_bank"].includes(draft.answerMode || "") && !draft.optionSourceId) && <fieldset><legend>选项</legend>{draft.options.map((option, index) => <div className="correction-option" key={index}><Input aria-label={`选项 ${index + 1} 标签`} value={option.label ?? ""} maxLength={16} onChange={e => set({ options: draft.options.map((v,i) => i === index ? { ...v, label: e.target.value || null } : v) })} /><textarea aria-label={`选项 ${index + 1} 内容`} value={option.content ?? ""} onChange={e => set({ options: draft.options.map((v,i) => i === index ? { ...v, content: e.target.value || null } : v) })} /><Button type="button" variant="ghost" onClick={() => set({ options: draft.options.filter((_,i) => i !== index) })}>移除选项 {index + 1}</Button></div>)}<Button type="button" variant="outline" disabled={draft.options.length >= 100} onClick={() => set({ options: [...draft.options, { label: "", content: "" }] })}>添加选项</Button></fieldset>}
    {draft.items.length > 0 && <p>题项编号：{itemLabels.join("；")}</p>}
    {composite ? <p>材料父题不填写答案；请在所属小题中校对答案。材料结构和来源关联会保留。</p> : draft.answerMode === "true_false" ? <label>参考答案<Select disabled={inputsLocked} value={answer || "missing"} onValueChange={value => setAnswer(value === "missing" ? "" : value)}><SelectOption value="missing">未提供</SelectOption><SelectOption value="true">正确</SelectOption><SelectOption value="false">错误</SelectOption></Select></label> : <label>参考答案<textarea aria-label="参考答案" value={answer} onChange={e => setAnswer(e.target.value)} aria-describedby="answer-format" /><span id="answer-format">{draft.answerMode === "choice" ? "填写选项标签，多选以逗号分隔；留空表示未提供。" : draft.answerMode === "fill_blank" ? "每行一个空的答案，空行保留为空答案。" : draft.answerMode === "ordering" ? "填写题项编号，以逗号分隔。" : draft.answerMode === "matching" ? "每行一组题项编号，例如 0=1；左右两侧分别编号。" : "留空表示未提供，不会自动补全。"}</span></label>}
    <label>解析<textarea value={draft.analysis ?? ""} maxLength={100000} onChange={e => set({ analysis: e.target.value || null })} /></label>
    <label>评分依据<textarea value={draft.scoringRubric ?? ""} maxLength={100000} onChange={e => set({ scoringRubric: e.target.value || null })} /></label>
    </fieldset>
    {error && <p role="alert">{error}</p>}
    <div className="task-actions"><Button disabled={locked} type="submit">{saving ? "正在保存…" : "保存修订"}</Button><Button type="button" variant="outline" disabled={locked || unconfirmed} onClick={onCancel}>放弃本次修改</Button></div>
  </form>;
}
