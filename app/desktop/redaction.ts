import type { QuestionRow } from "../src/api.js";
import { answerContent, object, text } from "./question-contract.js";

export function answerText(value: string): boolean {
  return value.toLowerCase().split(/[\n|]/).some(line => {
    const label = line.split(/[:：]/)[0].trim().replace(/^[*# ]+|[*# ]+$/g, "").trim().replace(/\s+/gu, " ");
    const answer = label.replace(/^(correct|reference|model) /, "");
    return ["answer", "answers", "answer key", "answer keys", "answers key", "answers keys"].includes(answer) ||
      ["solution", "solutions", "worked solution", "worked solutions", "analysis", "explanation", "explanations", "rubric", "rubrics", "scoring rubric", "scoring rubrics", "参考答案", "正确答案", "标准答案", "答案", "答案解析", "解析", "解答", "评分", "评分标准", "评分细则"].includes(label);
  });
}
function stripLines(q: unknown): void {
  const record = object(q);
  for (const key of ["stem", "instructions"]) if (answerText(text(q, key))) {
    let safe = "";
    for (const part of text(q, key).match(/[^\n|]*[\n|]|[^\n|]+$/g) ?? []) { if (answerText(part)) break; safe += part; }
    record[key] = safe.replace(/^[\n|]+|[\n|]+$/g, "").trimEnd();
  }
}
function clearFields(q: unknown): void { for (const key of ["answerPayload", "analysis", "sourceText", "scoringRubric", "scoreSourceText"]) object(q)[key] = null; }
function stripAnswers(q: unknown): void {
  stripLines(q); clearFields(q);
  const record = object(q);
  for (const key of ["contentBlocks", "passage"]) if (Array.isArray(record[key])) record[key] = record[key].filter(block => !answerContent(block));
}
export function redactSnapshot(snapshot: QuestionRow, exam: boolean, finished: boolean, submitted: boolean, open: Map<string, boolean>): void {
  if (exam && !finished) {
    clearFields(snapshot.question);
    snapshot.question.contentBlocks = snapshot.question.contentBlocks.filter(block => !answerContent(block));
    stripLines(snapshot.question);
    for (const material of snapshot.materials ?? []) stripLines(material);
  }
  const reveal = exam ? finished : submitted || finished;
  const protectedContent = exam || ["translation", "writing"].includes(snapshot.question.questionKind ?? "") || snapshot.materials?.some(q => q.answerMode === "listening");
  if (!reveal && protectedContent) stripAnswers(snapshot.question);
  let listeningLocked = false;
  for (const material of snapshot.materials ?? []) {
    const listening = material.answerMode === "listening", unlocked = finished || !exam && Boolean(open.get(material.id ?? ""));
    if (!reveal && protectedContent || listening && !unlocked) stripAnswers(material);
    if (listening && !unlocked) { material.transcript = []; listeningLocked = true; }
  }
  if (!reveal && protectedContent || listeningLocked) {
    snapshot.groups = snapshot.groups.filter(group => !answerText(group.title) && !answerText(group.instructions ?? ""));
    snapshot.visuals = snapshot.visuals.filter(visual => !answerContent(visual));
  }
  if (listeningLocked) snapshot.question.contentBlocks = snapshot.question.contentBlocks.filter(block => !answerContent(block));
  if (!reveal && protectedContent || listeningLocked) {
    snapshot.question.sourceText = null;
    for (const visual of snapshot.visuals) delete visual.sourceRef;
  }
}
