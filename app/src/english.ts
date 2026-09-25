import { t } from "./i18n";
import type { Question } from "./api";
export function countEnglishWords(text:string) { return text.match(/[\p{L}\p{N}]+(?:['’\-‐‑][\p{L}\p{N}]+)*/gu)?.length ?? 0; }
export function questionKinds(): Record<NonNullable<Question["questionKind"]>,string> {
  return {listening:t("听力题"),reading:t("阅读理解"),word_bank:t("选词填空"),cloze:t("完形填空"),grammar_fill:t("语法填空"),sentence_selection:t("七选五"),paragraph_matching:t("段落匹配"),translation:t("翻译题"),writing:t("写作题")};
}
export { QUESTION_KIND_MODES as kindModes } from "./contracts.generated";
