import type { ParsedGroup, Question } from "../src/contracts.generated.js";
import { SOURCE_WHITESPACE as space, SourceText, sourceLines, sourceTrim, sourceWithoutWhitespace } from "./source-text.js";

export interface OcrSourceEvidence { text: string; nativeTable?: { title: string; headers: string[] } }

// Python IGNORECASE also equates these letters when matching source headings.
const literal = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[iI]/g, "[iIİı]").replace(/[sS]/g, "[sSſ]").replace(/[kK]/g, "[kKK]");
const labels = ["Reading comprehension", "Word bank", "Cloze", "Ordering", "Matching"].map(literal).join("|");
const ordinary = ["Multiple choice", "True or false", "Fill in the blank", "Short answer", "Grammar fill", "Sentence selection"].map(literal).join("|");
const prefix = new RegExp(`^(?:\\p{Nd}+[.)]${space}*)?(?:(?:${labels})${space}*[—–]|(?:${ordinary})${space}*[:：])${space}*`, "iu");

/** Recover only a unique verbatim passage suffix; a guessed title is never proof. */
function exerciseTitle(heading: string, question: Question): string {
  const passage = question.passage ?? [];
  if (!passage.some(block => block.partType === "text" && block.textValue)) return heading;
  const pattern = passage.map(block => block.partType === "text" && block.textValue ? block.textValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : block.partType === "blank" ? `(?:\\(\\p{Nd}+\\)${space}*)?(?:_{2,}|\\[\\p{Nd}+\\])` : "").join("");
  const matches = heading.matchAll(new RegExp(pattern, "gu")), first = matches.next();
  if (first.done || first.value.index === 0 || !matches.next().done) return heading;
  return sourceTrim(heading.slice(0, first.value.index)).replace(new RegExp(`${space}*(?:${["Article", "Passage", "Transcript"].map(literal).join("|")})${space}*[:：]${space}*$`, "iu"), "");
}

function ocrTitles(label: string, separator: string, question: Question, text: string): Set<string> {
  const titles = new Set<string>(), heading = new RegExp(`^${space}*#*${space}*${label}${space}*${separator}${space}*([^\\r\\n]*)`, "iu");
  for (const line of sourceLines(text)) {
    const match = heading.exec(line); if (!match?.[1] || new RegExp(`^${space}`, "u").test(match[1])) continue;
    let title = exerciseTitle(sourceTrim(match[1]), question);
    if (question.items.length) title = sourceTrim(title.split(new RegExp(`(?:${["Items", "Left", "Right"].map(literal).join("|")})${space}*:${space}*\\p{Nd}+[.)]`, "iu"))[0]);
    if (title && !new RegExp(`(?:${["Article", "Passage", "Bank", "Items", "Left", "Right", "Transcript", "Answers?"].map(value => value === "Answers?" ? literal("Answer") + "s?" : literal(value)).join("|")})${space}*[:：]`, "iu").test(title)) titles.add(title);
  }
  return titles;
}

function passageMatchesSource(question: Question, text: string): boolean {
  const passage = question.passage ?? [], marker = "\ue000";
  if (!passage.some(block => block.partType === "blank") || passage.some(block => !["text", "blank"].includes(block.partType)) || text.includes(marker) || passage.some(block => block.textValue?.includes(marker))) return true;
  const normalized = text.replace(new RegExp(`(?:\\(\\p{Nd}+\\)${space}*)?_{2,}|\\[\\p{Nd}+\\]`, "gu"), marker), source = new SourceText(normalized), positions: number[] = [], kept: string[] = [];
  let index = 0; for (const char of normalized) { if (/[\p{L}\p{N}\ue000]/u.test(char)) { positions.push(index); kept.push(char); } index++; }
  const draft = passage.map(block => block.partType === "blank" ? marker : block.textValue ?? "").join(""), needle = [...draft].filter(char => /[\p{L}\p{N}\ue000]/u.test(char)).join(""), letters = kept.join(""), start = letters.indexOf(needle);
  if (!needle || start < 0 || letters.indexOf(needle, start + 1) >= 0) return true;
  const letterIndex = new SourceText(letters).point(start); let begin = positions[letterIndex], end = positions[letterIndex + new SourceText(needle).length - 1] + 1;
  while (begin > 0 && "\"'“‘([{".includes(source.slice(begin - 1, begin))) begin--;
  while (end < source.length && ".!?。！？\"'”’)]}".includes(source.slice(end, end + 1))) end++;
  return sourceWithoutWhitespace(source.slice(begin, end)) === sourceWithoutWhitespace(draft);
}

export function ocrPageViolations(questions: Question[], groups: ParsedGroup[], evidence: OcrSourceEvidence): string[] {
  const violations: string[] = [], { text, nativeTable } = evidence;
  if (nativeTable) {
    if (!groups.some(group => group.title === nativeTable.title && group.questionIndexes.length === questions.length && [...group.questionIndexes].sort((a, b) => a - b).every((value, position) => value === position))) violations.push(`Retain the native worksheet group ${JSON.stringify(nativeTable.title)} with every question index, including parents`);
    if (groups.some(group => nativeTable.headers.includes(group.title) && group.title !== nativeTable.title)) violations.push("Native table column headers are not worksheet/section groups; use table_name and only explicit Section: boundaries");
    const sections = new Set(sourceLines(text).flatMap(line => { const match = new RegExp(`^${space}*${literal("Section")}:${space}*([^\\r\\n]*)`, "iu").exec(line); return match?.[1] && !new RegExp(`^${space}`, "u").test(match[1]) ? [sourceTrim(match[1])] : []; }));
    if (groups.some(group => group.title !== nativeTable.title && !sections.has(group.title))) violations.push("Native worksheet groups must use table_name or a literal explicit Section: title; exercise type headings are not additional sections");
  }
  for (const [label, mode, cue] of [["Reading comprehension", "reading", `${literal("Article")}${space}*:`], ["Word bank", "word_bank", `${literal("Bank")}${space}*:`], ["Cloze", "cloze", `${literal("Passage")}${space}*:|\\[\\p{Nd}+\\]`], ["Grammar fill", "gap_fill", `\\(\\p{Nd}+\\)${space}*_{2,}`], ["Listening", "listening", `${literal("Transcript")}${space}*:`]]) {
    if (new RegExp(`(?:^|\\n)${space}*#*${space}*${literal(label)}${space}*[:—–]${space}*[^${space.slice(1, -1)}]`, "iu").test(text) && new RegExp(cue, "iu").test(text) && !questions.some(question => question.answerMode === mode)) violations.push(`The supplied ${label} heading and material require a separate ${mode} parent with answerPayload=null and answerable children; do not flatten it into an ordinary answered question`);
  }
  const byId = new Map(questions.filter(question => question.id).map(question => [question.id!, question]));
  for (const question of questions) {
    if (!passageMatchesSource(question, text)) violations.push("Preserve every source passage character and punctuation before, between and after blanks; replace only the printed gap markers with blank blocks");
    const stem = question.stem ?? "";
    if (question.answerMode === "fill_blank" && new RegExp(`^\\$[^$\\n]*=${space}*\\$${space}*_{2,}[.!?。！？]?$`, "u").test(stem) && /\\(?:times|div|frac|sqrt|cdot)\b/.test(stem)) violations.push("OCR wrapped only the equation prefix in math delimiters. Keep the complete unsolved equation and its exact blank/punctuation together in stem; use readable math symbols, with LaTeX in formula contentBlocks, not a dollar-wrapped prefix followed by a bare blank");
    if (question.answerMode === "choice") for (const option of question.options) {
      if (!option.label || !option.content) continue;
      const pattern = `[?？]${space}*${option.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[.)、．]${space}*${option.content.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, duplicate = new RegExp(pattern + `${space}*$`, "u").exec(stem);
      if (duplicate && new RegExp(pattern, "u").test(text)) violations.push(`Keep the option in options, not in stem. Preserve the complete printed question ending at its question mark: ${stem.slice(0, duplicate.index + 1)}`);
    }
    const parent = question.parentId ? byId.get(question.parentId) : undefined;
    if (parent && ["word_bank", "cloze"].includes(parent.answerMode ?? "") && question.id) {
      const passage = parent.passage ?? [];
      const marker = new RegExp(`${space}*(?:\\[\\p{Nd}+\\]|\\(\\p{Nd}+\\)${space}*_{2,}|_{2,})[.!?。！？]?${space}*$`, "u").exec(stem);
      if (marker) for (const [position, block] of passage.entries()) {
        if (block.partType !== "blank" || block.questionId !== question.id) continue;
        const parts: string[] = []; for (let previous = position - 1; previous >= 0 && passage[previous].partType === "text"; previous--) parts.unshift(passage[previous].textValue ?? "");
        const clause = sourceTrim(parts.join("")).replace(new RegExp(`^[.!?;。！？；]${space}+`, "u"), "");
        if (clause && sourceTrim(stem.slice(0, marker.index)) === clause) violations.push(`This child already owns a parent passage blank. Its stem is the preceding clause ${JSON.stringify(clause)}; keep the printed gap number and sentence punctuation only in the parent passage`);
      }
    }
    if (parent?.answerMode === "gap_fill") {
      const hints = new Set(sourceLines(text).flatMap(line => { const match = new RegExp(`^${space}*\\p{Nd}+[.)]${space}*(${literal("Hint")}${space}*:${space}*[^${space.slice(1, -1)}][^\\r\\n]*)`, "iu").exec(line); return match && !new RegExp(`(?:${literal("Reference")}${space}+)?${literal("Answer")}${space}*:`, "iu").test(match[1]) ? [sourceTrim(match[1])] : []; }));
      if (questions.filter(child => child.parentId === parent.id).length === 1 && hints.size === 1 && questions.filter(item => item.answerMode === "gap_fill").length === 1 && (stem !== [...hints][0] || question.blankCount !== 1)) violations.push("The single grammar blank has its own numbered Hint: line: use that exact hint as the child stem, blankCount=1; keep the shared sentence only on the parent");
    }
  }
  return violations;
}

/** Literal titles and gap markers use the trusted source, including OCR ambiguity rules. */
export function sourceFidelityViolations(questions: Question[], ocr?: OcrSourceEvidence): string[] {
  const violations: string[] = [];
  for (const question of questions) {
    const stem = question.stem ?? "", quote = question.sourceText ?? "", printedPrefix = prefix.exec(stem);
    if (printedPrefix && new RegExp(literal(sourceTrim(printedPrefix[0])), "iu").test(quote)) violations.push("Remove the printed question number/type prefix from stem; keep only the remaining wording and put material in its own fields");
    const kind = question.questionKind || question.answerMode || "";
    if (["grammar_fill", "sentence_selection", "word_bank", "cloze", "ordering", "matching", "reading", "listening", "paragraph_matching"].includes(kind)) {
      const label = literal(kind === "reading" ? "reading comprehension" : kind.replaceAll("_", " "));
      const separator = ["listening", "paragraph_matching"].includes(kind) ? ":" : ["grammar_fill", "sentence_selection"].includes(kind) ? "[:—–]" : "[—–]";
      const titles = ocr ? ocrTitles(label, separator, question, ocr.text) : new Set<string>();
      if (titles.size === 1 && questions.filter(item => item.answerMode === question.answerMode).length === 1) {
        const title = [...titles][0]; if (stem !== title) violations.push(`Preserve the printed exercise title without its type prefix or passage: ${title}`);
        if (question.answerMode === "matching" && title.includes("(one-to-one)") && question.matchingVariant !== "one_to_one") violations.push("Preserve the explicit (one-to-one) matching policy as matchingVariant=one_to_one");
      }
      const heading = new RegExp(`^${label}[ \\t]*${separator}[ \\t]*([^\\r\\n]*)`, "iu").exec(quote);
      if (heading && heading[1] && !new RegExp(`^${space}`, "u").test(heading[1])) {
        const title = exerciseTitle(sourceTrim(heading[1]), question);
        if (stem !== title && (!["listening", "paragraph_matching"].includes(kind) || stem === sourceTrim(heading[0]))) {
          if (ocr && (!sourceLines(ocr.text).some(line => sourceTrim(sourceTrim(line).replace(/^#+/, "")) === sourceTrim(heading[0])) || title === sourceTrim(heading[1]) && /(?:Article|Passage|Bank|Items|Left|Right|Transcript|Answers?)\s*[:：]/iu.test(heading[1]))) question.needsReview = true;
          else violations.push(`Preserve the printed exercise title without its type prefix or passage: ${title}`);
        }
      }
    }
    if (["grammar_fill", "sentence_selection"].includes(question.questionKind ?? "")) {
      const passage = question.passage ?? [];
      for (let index = 1; index < passage.length; index++) {
        const previous = passage[index - 1], blank = passage[index];
        if (previous.partType === "text" && previous.textValue && blank.partType === "blank" && new RegExp(`\\(\\p{Nd}+\\)${space}*$`, "u").test(previous.textValue) && quote.includes(previous.textValue + "__")) violations.push("Replace the whole printed gap marker, including its number, with the blank block; keep surrounding words unchanged");
      }
    }
  }
  return violations;
}
