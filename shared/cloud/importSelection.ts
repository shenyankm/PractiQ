import { t } from "./i18n";
import type { DocumentReparseSelection } from "./contracts.generated";

export function validPages(value: unknown): value is number[] | null | undefined {
  return value == null || Array.isArray(value) && value.length > 0 && value.length <= 2000 && value.every(v => Number.isSafeInteger(v) && v >= 1 && v <= 2000);
}
export function parsePages(raw: string): number[] | undefined {
  if (!raw.trim()) return undefined;
  const pages = new Set<number>();
  for (const piece of raw.trim().split(/[,，\s]+/)) {
    const match = piece.match(/^(\d+)(?:-(\d+))?$/);
    if (!match) throw Error(t("页码请填写如 1,3-5 的范围。"));
    const first = Number(match[1]), last = Number(match[2] ?? match[1]);
    if (first < 1 || last < first || last > 2000) throw Error(t("请选择 1–2000 内从小到大的页码范围。"));
    for (let index = first; index <= last; index++) pages.add(index);
  }
  return [...pages].sort((a, b) => a - b);
}
export function validReparseSelection(value: unknown): value is DocumentReparseSelection | null | undefined {
  if (value == null) return true;
  const v = value as DocumentReparseSelection;
  return typeof v === "object" && Object.keys(v).every(k => ["checkpointId", "units"].includes(k)) && typeof v.checkpointId === "string" && v.checkpointId.length > 0 && v.checkpointId.length <= 255 && Array.isArray(v.units) && v.units.length > 0 && v.units.length <= 2000 && v.units.every(u => u && ["document_parse", "vision_parse"].includes(u.stage) && Number.isSafeInteger(u.index) && u.index >= 0 && Object.keys(u).every(k => ["stage", "index"].includes(k)));
}
