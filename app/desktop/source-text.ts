import { invariant } from "./errors.js";

// Python source offsets count code points and its whitespace set excludes BOM.
export const SOURCE_WHITESPACE = "[\\t-\\r\\x1c-\\x20\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const space = new RegExp(`^${SOURCE_WHITESPACE}$`, "u"), all = new RegExp(SOURCE_WHITESPACE, "gu");
export const sourceSpace = (value: string): boolean => space.test(value);
export function sourceTrim(value: string): string {
  let start = 0, end = value.length;
  while (start < end && sourceSpace(value[start])) start++; while (end > start && sourceSpace(value[end - 1])) end--;
  return value.slice(start, end);
}
export const sourceWithoutWhitespace = (value: string): string => value.replace(all, "");
export const sourceDecimalDigits = (value: string): string => [...value].map(char => { const point = char.codePointAt(0)!; let first = point; while (first > 0 && /\p{Nd}/u.test(String.fromCodePoint(first - 1))) first--; return String((point - first) % 10); }).join("").replace(/^0+(?=.)/, "");
export function sourceLines(value: string, keepEnds = false): string[] {
  const lines: string[] = []; let start = 0;
  for (const match of value.matchAll(/\r\n|[\n\r\v\f\x1c-\x1e\u0085\u2028\u2029]/gu)) { lines.push(value.slice(start, match.index + (keepEnds ? match[0].length : 0))); start = match.index + match[0].length; }
  if (start < value.length) lines.push(value.slice(start)); return lines;
}
export class SourceText {
  readonly length: number;
  private readonly offsets?: Uint32Array;
  constructor(readonly text: string) {
    if (!/[\ud800-\udbff][\udc00-\udfff]/.test(text)) { this.length = text.length; return; }
    let count = 0; for (const _char of text) count++;
    this.length = count; this.offsets = new Uint32Array(count + 1); let index = 0, offset = 0;
    for (const char of text) { this.offsets[index++] = offset; offset += char.length; } this.offsets[index] = offset;
  }
  slice(start: number, end = this.length): string {
    invariant(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start <= end && end <= this.length, "SOURCE_SELECTION_INVALID", "Invalid source character range");
    return this.text.slice(this.offsets?.[start] ?? start, this.offsets?.[end] ?? end);
  }
  point(offset: number): number {
    invariant(Number.isSafeInteger(offset) && offset >= 0 && offset <= this.text.length, "SOURCE_SELECTION_INVALID", "Invalid source string offset");
    if (!this.offsets) return offset; let left = 0, right = this.length;
    while (left < right) { const middle = (left + right) >>> 1; if (this.offsets[middle] < offset) left = middle + 1; else right = middle; }
    invariant(this.offsets[left] === offset, "SOURCE_SELECTION_INVALID", "Source offset splits a Unicode character"); return left;
  }
}
