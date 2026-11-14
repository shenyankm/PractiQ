import { parseEntities } from "parse-entities";
import type { PageFigure } from "../src/contracts.generated.js";
import { validateContract } from "./contracts.js";
import { invariant } from "./errors.js";
import { modelDefaults } from "./model-defaults.js";
import { object } from "./question-contract.js";
import { SOURCE_WHITESPACE as space, SourceText, sourceLines, sourceTrim } from "./source-text.js";

export const isAnswerRole = (role: string | null | undefined): boolean => ["answer", "analysis", "solution", "explanation", "rubric", "答案", "解析", "解答", "评分"].some(word => (role ?? "").toLowerCase().includes(word));
const ci = (pattern: string) => pattern.replace(/i/gi, "[iİı]");
const answerHeading = new RegExp(ci(`^(?:(?:(?:correct|reference|model)${space}+)?answers?(?:${space}+keys?)?|(?:worked${space}+)?solutions?|analysis|explanations?|(?:scoring${space}+)?rubrics?|(?:参考|正确|标准)?答案|答案解析|解析|解答|评分(?:标准|细则)?)(?:${space}*[:：]|${space}*$)`), "iu");
const length = (value: string): number => new SourceText(value).length;

export function tableContentKey(text: string): string {
  const rows = sourceLines(sourceTrim(text)).map(line => { const cells = sourceTrim(line).split(/(?<!\\)\|/u); if (cells.length && !cells[0]) cells.shift(); if (cells.length && !cells.at(-1)) cells.pop(); return cells.map(cell => parseEntities(sourceTrim(cell).replaceAll("\\|", "|"))); });
  if (rows.length >= 2 && rows[1].length && rows[1].every(cell => /^:?-+:?$/u.test(cell)) && rows.every(row => row.length === rows[0].length)) return "table:[" + [rows[0], ...rows.slice(2)].map(row => "[" + row.map(cell => JSON.stringify(cell)).join(", ") + "]").join(", ") + "]";
  return "text:" + sourceTrim(text);
}
export function tableMarkdown(figure: Pick<PageFigure, "tableRows">): string | null {
  if (figure.tableRows == null) return null;
  const cell = (value: string): string => value.split(/(\$(?:[^$\n]|\\\$)+\$)/u).map((part, index) => (index % 2 ? part : part.replace(/[\\`*_{}\[\]()<>!#&$~]/gu, char => `&#${char.codePointAt(0)};`)).replaceAll("|", "\\|")).join("").replaceAll("\n", " ").replaceAll("\r", " ");
  const rows = figure.tableRows.map(row => "| " + row.map(cell).join(" | ") + " |"); rows.splice(1, 0, "| " + figure.tableRows[0].map(() => "---").join(" | ") + " |"); return rows.join("\n");
}
export function validatePageFigure(input: unknown): PageFigure {
  invariant(input !== null && typeof input === "object" && !Array.isArray(input), "UNIT_RESULT_INVALID", "Invalid page figure");
  const known = modelDefaults("PageFigure", {}), source = object(structuredClone(input));
  known.questionIndexes = [];
  for (const key of ["bbox", "description"]) if (Object.hasOwn(source, key)) known[key] = source[key];
  for (const key of Object.keys(known)) if (Object.hasOwn(source, key)) known[key] = source[key];
  if (Array.isArray(known.bbox)) known.bbox = known.bbox.map(value => typeof value === "boolean" ? Number(value) : typeof value === "string" && /^[+-]?(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?$/u.test(sourceTrim(value)) ? Number(sourceTrim(value).replaceAll("_", "")) : value);
  if (Array.isArray(known.tableRows) && !known.tableRows.length) known.tableRows = null;
  validateContract("PageFigure", known); const figure = known as unknown as PageFigure;
  if (figure.bbox) invariant(figure.bbox.every(value => Number.isFinite(value) && value >= 0 && value <= 1) && figure.bbox[2] > figure.bbox[0] && figure.bbox[3] > figure.bbox[1], "UNIT_RESULT_INVALID", "Invalid fixed source figure bounds");
  const texts = [...(figure.tableRows ?? []).flat(), ...(figure.extractedText ?? "").split(/[|\n]/u)];
  if (isAnswerRole(figure.role) || figure.kind === "table" && texts.some(text => answerHeading.test(sourceTrim(text).replace(/^[*# ]+|[*# ]+$/gu, "")))) figure.role = "answer";
  if (figure.tableRows != null) {
    invariant(figure.kind === "table" && figure.tableRows.every(row => row.length <= 100), "UNIT_RESULT_INVALID", "Table rows require table kind and at most 100 columns");
    invariant(figure.tableRows.reduce((sum, row) => sum + row.reduce((count, text) => count + length(text), 0), 0) <= 90000, "UNIT_RESULT_INVALID", "Table text exceeds its limit");
    if (figure.tableRows.length < 2 || !figure.tableRows[0].length || figure.tableRows.some(row => row.length !== figure.tableRows![0].length) || length(tableMarkdown(figure) ?? "") > 100000) {
      const text = figure.extractedText || figure.tableRows.map(row => row.join("\t")).join("\n"), source = new SourceText(text); figure.extractedText = source.slice(0, Math.min(100000, source.length)); figure.tableRows = null;
    }
  }
  return figure;
}
