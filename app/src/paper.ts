import { t, MessageError, message } from "./i18n";
import { type Question } from "./api";
export function types(): Record<string,string> { return {single:t("单选"),multiple:t("多选"),true_false:t("判断"),fill_blank:t("填空"),short_answer:t("简答"),ordering:t("排序"),matching:t("匹配"),reading:t("阅读理解"),word_bank:t("选词填空"),cloze:t("完形填空"),listening:t("听力题"),grammar_fill:t("语法填空"),sentence_selection:t("七选五"),paragraph_matching:t("段落匹配"),translation:t("翻译题"),writing:t("写作题")}; }
export function questionType(q: Question) { return q.answerMode === "choice" ? q.choiceVariant || "choice" : q.answerMode || "unknown"; }
export function cents(value: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) throw new MessageError(message("分数最多保留两位小数"));
  const [whole, decimal=""] = value.split(".");
  const n=Number(whole)*100+Number(decimal.padEnd(2,"0"));
  if (!Number.isSafeInteger(n) || n>100_000_000) throw new MessageError(message("分数超过上限"));
  return n;
}
