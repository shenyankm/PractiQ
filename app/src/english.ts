import { contentLanguage, locale, t } from "./i18n";
import type { Question } from "./api";
export function countEnglishWords(text:string) {
  const words = /[\p{L}\p{N}]+(?:['’\-‐‑][\p{L}\p{N}]+)*/gu;
  let count = 0;
  while (words.test(text)) count++;
  return count;
}
export function materialLanguage(question: Question, role?: string | null): string | undefined {
  const english = question.questionKind && !["translation", "writing"].includes(question.questionKind) ? "en" : undefined;
  if (role === "source_text") return contentLanguage(question.sourceLanguage) ?? english;
  if (role === "target_text" || role === "starter_text") return contentLanguage(question.targetLanguage) ?? english;
  if (role && role !== "material") return undefined;
  return english;
}
export function answerLanguage(question?: Question) {
  return question ? contentLanguage(question.targetLanguage) ?? materialLanguage(question) : undefined;
}
export function questionKinds(): Record<NonNullable<Question["questionKind"]>,string> {
  return {listening:t("听力题"),reading:t("阅读理解"),word_bank:t("选词填空"),cloze:t("完形填空"),grammar_fill:t("语法填空"),sentence_selection:t("七选五"),paragraph_matching:t("段落匹配"),translation:t("翻译题"),writing:t("写作题")};
}
export { QUESTION_KIND_MODES as kindModes } from "./contracts.generated";

export function languageLabel(code: string) {
  try { return new Intl.DisplayNames([locale()], {type:"language"}).of(code) ?? code; }
  catch { return code; }
}
export function writingGenreLabel(value: string) {
  return ({invitation:t("邀请函"),letter:t("书信"),email:t("电子邮件"),essay:t("议论文"),report:t("报告"),story:t("故事")} as Record<string,string>)[value.toLowerCase()] ?? value;
}
