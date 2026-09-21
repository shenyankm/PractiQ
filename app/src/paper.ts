import { t, MessageError, message } from "./i18n";
import { type Question, type QuestionRow } from "./api";
export function types(): Record<string,string> { return {single:t("单选"),multiple:t("多选"),true_false:t("判断"),fill_blank:t("填空"),short_answer:t("简答"),ordering:t("排序"),matching:t("匹配")}; }
export function questionType(q: Question) { return q.answerMode === "choice" ? q.choiceVariant || "choice" : q.answerMode || "unknown"; }
export function cents(value: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) throw new MessageError(message("分数最多保留两位小数"));
  const [whole, decimal=""] = value.split(".");
  const n=Number(whole)*100+Number(decimal.padEnd(2,"0"));
  if (!Number.isSafeInteger(n) || n>100_000_000) throw new MessageError(message("分数超过上限"));
  return n;
}
export function split(total: number, count: number): number[] {
  if (!Number.isInteger(total) || count<1 || total<count) throw new MessageError(message("每题至少 0.01 分，请增加预算或减少题目"));
  return Array.from({length:count},(_,i)=>Math.floor(total/count)+(i<total%count?1:0));
}
export function allocate(rows: QuestionRow[], total: number, budgets?: Record<string,number>): number[] {
  if (!budgets) return split(total,rows.length);
  const groups = new Map<string,number[]>();
  rows.forEach((q,i)=> {const key=questionType(q.question); groups.set(key,[...(groups.get(key)||[]),i]);});
  if ([...groups.keys()].reduce((n,k)=>n+(budgets[k]||0),0)!==total) throw new MessageError(message("题型预算之和必须等于总分"));
  const scores=Array<number>(rows.length).fill(0);
  groups.forEach((indexes,k)=>{const values=split(budgets[k]||0,indexes.length);indexes.forEach((idx,i)=>{scores[idx]=values[i];});});
  return scores;
}
export function sample(rows: QuestionRow[], count: number, random: boolean) {
  if (!Number.isInteger(count) || count<1 || count>1000 || count>rows.length) throw new MessageError(message("可用题数不足或题数不合法（1–1000）"));
  const values=[...rows];
  if(random) for(let i=values.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[values[i],values[j]]=[values[j],values[i]];}
  return values.slice(0,count);
}
