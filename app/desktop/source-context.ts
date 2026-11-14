import { evidenceText } from "./tencent-bundle.js";
import { SOURCE_WHITESPACE as space, sourceDecimalDigits } from "./source-text.js";

export const MAX_CONTEXT_PAGES = 8;
const line = "(?:^|(?<=\\n))", ci = (pattern: string) => pattern.replace(/i/gi, "[iİı]");
const numbers = () => new RegExp(ci(`${line}${space}*(?:#{1,6}${space}*)?(?:q(?:uestion)?${space}*|第${space}*)?(\\p{Nd}{1,4})${space}*(?:[.、)．:：](?!\\p{Nd})|题)`), "giu");
const answers = new RegExp(ci(`${line}${space}*(?:#{1,6}${space}*)?(?:(?:参考答案|标准答案|答案)(?:与(?:解析|评分细则|评分标准))?|answer${space}*key|answers|solutions)${space}*[:：]?${space}*(?=\\n|$)`), "iu");
export { numbers as sourceNumbers, answers as sourceAnswerHeading };
const references = () => new RegExp(ci(`(?:see|refer${space}+to)${space}+pages?${space}*(\\p{Nd}{1,3})(?:${space}*[-–]${space}*(\\p{Nd}{1,3}))?|(?:参见|参考|见)第${space}*(\\p{Nd}{1,3})(?:${space}*[-–至到]${space}*(\\p{Nd}{1,3}))?${space}*页`), "giu");
export function sourceContext(pages: { elements?: unknown[]; failed?: boolean }[], pageReferences = true): [number[][], number[]] {
  const texts = pages.map(page => page.failed ? "" : evidenceText(page.elements ?? [])), ids = texts.map(text => new Set([...text.matchAll(numbers())].map(match => match[1]))), answerPages = new Set(texts.flatMap((text, index) => answers.test(text) ? [index] : [])), owners = new Map<string, number>();
  ids.forEach((values, index) => { if (!answerPages.has(index)) for (const value of values) owners.set(value, (owners.get(value) ?? 0) + 1); });
  const failedPrefix = [0]; for (const page of pages) failedPrefix.push(failedPrefix.at(-1)! + Number(Boolean(page.failed)));
  const byAnswer = new Map<string, Set<number>>(); for (const index of answerPages) for (const value of ids[index]) { const found = byAnswer.get(value) ?? new Set(); found.add(index); byAnswer.set(value, found); }
  const plans: number[][] = [], incomplete: number[] = [];
  for (const [index, text] of texts.entries()) {
    const adjacent = Array.from({ length: Math.min(pages.length, index + 2) - Math.max(0, index - 2) }, (_, offset) => Math.max(0, index - 2) + offset), linked = new Set<number>(); let invalid = false;
    for (const match of text.matchAll(references())) {
      if (!pageReferences) { invalid = true; continue; }
      const start = match[1] || match[3], end = match[1] ? match[2] : match[4], first = Number(sourceDecimalDigits(start)) - 1, last = Number(sourceDecimalDigits(end || start)) - 1;
      if (!(0 <= first && first <= last && last < pages.length)) { invalid = true; continue; } for (let page = first; page <= last; page++) linked.add(page);
    }
    if (!answerPages.has(index)) for (const value of ids[index]) if (owners.get(value) === 1) for (const page of byAnswer.get(value) ?? []) linked.add(page);
    const selected: number[] = [];
    for (const other of [...adjacent, ...[...linked].sort((a, b) => a - b)]) {
      if (selected.includes(other)) continue;
      if (failedPrefix[Math.max(index, other) + 1] !== failedPrefix[Math.min(index, other)]) { invalid ||= linked.has(other); continue; }
      if (selected.length >= MAX_CONTEXT_PAGES) { invalid = true; break; } selected.push(other);
    }
    plans.push(selected.sort((a, b) => a - b)); if (invalid) incomplete.push(index);
  }
  return [plans, incomplete];
}
