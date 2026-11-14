import { SaxesParser } from "saxes";
import sharp from "sharp";
import { crc32 } from "node:zlib";
import { BoundedZip } from "./zip.js";
import { AppError, invariant } from "./errors.js";
import { parseJson } from "./document-contract.js";
import { validateImage } from "./media.js";
import { object } from "./question-contract.js";
import { sourceLines, sourceTrim as trim } from "./source-text.js";
import type { OcrSourceEvidence } from "./source-fidelity.js";

const PAGE_BYTES = 8 * 1024 * 1024;
export interface TencentBundleLimits { maxTotalInputChars: number; maxVisionPagePixels: number; visionMaxBytes: number }
export const TENCENT_BUNDLE_LIMITS: TencentBundleLimits = { maxTotalInputChars: 2_000_000, maxVisionPagePixels: 25_000_000, visionMaxBytes: 50 * 1024 * 1024 };
export type TencentBox = [number, number, number, number];
export interface TencentFigure { elementIndex: number; kind: "image" | "table"; bbox: TencentBox | null; imageMember: string | null; cropBbox?: TencentBox }
export interface TencentPage { page: number; format?: "markdown" | "table"; width?: number; height?: number; elements: Record<string, unknown>[]; figures: TencentFigure[] }
export interface TencentBundleOptions { pageCount: number; resultType?: 2 | 9; allowEmpty?: boolean; limits?: Partial<TencentBundleLimits>; signal?: AbortSignal }
const valid = (condition: unknown): void => invariant(condition, "TENCENT_RESULT_INVALID", "Tencent result archive is invalid or uses an unsupported layout");
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const characters = (text: string): number => { let count = 0; for (const _character of text) count++; return count; };
function digits(text: string): number {
  valid(/^\p{Nd}+$/u.test(text)); let result = 0;
  for (const character of text) { const point = character.codePointAt(0)!; let first = point; while (first > 0 && /\p{Nd}/u.test(String.fromCodePoint(first - 1))) first--; result = result * 10 + (point - first) % 10; valid(Number.isSafeInteger(result)); } return result;
}
export function evidenceText(value: unknown, depth = 0): string {
  valid(depth <= 128); if (typeof value === "string") return value;
  return Array.isArray(value) || record(value) ? Object.values(value).map(item => evidenceText(item, depth + 1)).filter(Boolean).join("\n\n") : "";
}
/** Native XML cell text is the proof; formatted column-name aliases are not. */
export function ocrSourceEvidence(page: TencentPage): OcrSourceEvidence {
  const tables = page.elements.filter(element => Object.hasOwn(element, "table_info")), layouts = page.format === "table" ? page.elements.flatMap(element => typeof element.layout_xml === "string" && element.layout_xml ? [element.layout_xml] : []) : [];
  const cells: string[] = [];
  for (const layout of layouts) {
    valid(Buffer.byteLength(layout) <= PAGE_BYTES);
    const parser = new SaxesParser({ xmlns: true }), active: { index: number; depth: number }[] = []; let depth = 0;
    parser.on("error", error => { throw error; }); parser.on("doctype", () => { throw new AppError("TENCENT_RESULT_INVALID", "XML document types are forbidden"); });
    parser.on("opentag", tag => { valid(++depth <= 128); if (tag.local === "td" && !tag.uri) { active.push({ index: cells.length, depth }); cells.push(""); } });
    const append = (value: string) => { for (const cell of active) cells[cell.index] += value; }; parser.on("text", append); parser.on("cdata", append);
    parser.on("closetag", () => { if (active.at(-1)?.depth === depth) active.pop(); depth--; }); parser.write(layout).close();
  }
  const table = tables.length === 1 && page.format === "table" ? object(tables[0].table_info) : null;
  if (table) valid(typeof table.table_name === "string" && Array.isArray(table.fields) && table.fields.every(record));
  return { text: (layouts.length ? cells : sourceLines(evidenceText(page.elements))).join("\n"), ...(table ? { nativeTable: { title: String(table.table_name), headers: (table.fields as Record<string, unknown>[]).flatMap(field => typeof field.formatted_field_name === "string" ? [field.formatted_field_name] : []) } } : {}) };
}
export function elementBox(element: Record<string, unknown>, width: number, height: number): TencentBox {
  valid(width > 0 && height > 0); const polygon = object(element.polygon), points = ["left_top", "right_top", "left_bottom", "right_bottom"].map(key => object(polygon[key]));
  valid(points.every(point => [point.x, point.y].every(value => typeof value === "number" && Number.isFinite(value))));
  const xs = points.map(point => Number(point.x)), ys = points.map(point => Number(point.y)), result: TencentBox = [Math.min(...xs) / width, Math.min(...ys) / height, Math.max(...xs) / width, Math.max(...ys) / height];
  valid(result.every(value => Number.isFinite(value) && value >= 0 && value <= 1) && result[0] < result[2] && result[1] < result[3]); return result;
}
const intersects = (left: TencentBox, right: TencentBox) => Math.max(left[0], right[0]) < Math.min(left[2], right[2]) && Math.max(left[1], right[1]) < Math.min(left[3], right[3]);
const contains = (outer: TencentBox, inner: TencentBox) => outer[0] <= inner[0] && inner[2] <= outer[2] && outer[1] <= inner[1] && inner[3] <= outer[3];
export function labelCropBox(figure: Record<string, unknown>, elements: Record<string, unknown>[], width: number, height: number): TencentBox | null {
  // shortcut: retain the original 1,000-element repair cap; revisit only with dense-page evidence.
  if (elements.length > 1000 || !elements.every(record)) return null;
  const original = elementBox(figure, width, height), labels = new Set(evidenceText(figure.figure_info).split(/\r\n|[\n\r\v\f\x1c-\x1e\u0085\u2028\u2029]/u).map(trim).filter(text => /^[\p{L}\p{N}_.()+−/\-]{1,16}$/u.test(text))), candidates: { element: Record<string, unknown>; text: string; box: TencentBox }[] = [];
  if (!labels.size) return null;
  for (const element of elements) {
    if (element === figure || !record(element.text_info) || typeof element.text_info.content !== "string") continue;
    const text = trim(element.text_info.content); if (!labels.has(text)) continue;
    let box: TencentBox; try { box = elementBox(element, width, height); } catch { continue; }
    if (intersects(box, original) && !contains(original, box)) candidates.push({ element, text, box });
  }
  if (!candidates.length || new Set(candidates.map(candidate => candidate.text)).size !== candidates.length) return null;
  const boxes = [original, ...candidates.map(candidate => candidate.box)], crop: TencentBox = [Math.min(...boxes.map(box => box[0])), Math.min(...boxes.map(box => box[1])), Math.max(...boxes.map(box => box[2])), Math.max(...boxes.map(box => box[3]))];
  if ((crop[2] - crop[0]) * (crop[3] - crop[1]) > 1.25 * (original[2] - original[0]) * (original[3] - original[1])) return null;
  for (const element of elements) {
    if (element === figure || candidates.some(candidate => candidate.element === element)) continue;
    let box: TencentBox; try { box = elementBox(element, width, height); } catch { return null; }
    if (intersects(box, crop) && !contains(original, box)) return null;
  } return crop;
}

interface XmlNode { name: string; namespace: string; attributes: Record<string, string>; children: (XmlNode | string)[]; bindings: Map<string, string>; tail?: string }
const xmlText = (node: XmlNode): string => node.children.map(child => typeof child === "string" ? child : xmlText(child)).join("");
const escapeXml = (text: string, attribute = false) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', attribute ? "&quot;" : '"').replaceAll("\r", attribute ? "&#13;" : "\r").replaceAll("\n", attribute ? "&#10;" : "\n").replaceAll("\t", attribute ? "&#09;" : "\t");
function serializeXml(node: XmlNode, root = true): string {
  const attributes = { ...node.attributes };
  if (root) for (const [prefix, value] of node.bindings) { const name = prefix ? `xmlns:${prefix}` : "xmlns"; if (!Object.hasOwn(attributes, name) && value) attributes[name] = value; }
  const start = `<${node.name}${Object.entries(attributes).map(([key, value]) => ` ${key}="${escapeXml(value, true)}"`).join("")}`;
  return (node.children.length ? `${start}>${node.children.map(child => typeof child === "string" ? escapeXml(child) : serializeXml(child, false)).join("")}</${node.name}>` : `${start} />`) + (root ? escapeXml(node.tail ?? "") : "");
}
export function xmlSource(bytes: Buffer): string {
  const declared = /encoding\s*=\s*["']([^"']+)["']/i.exec(bytes.subarray(0, 512).toString("latin1"))?.[1].toLowerCase().replaceAll(/[-_]/g, ""), first = bytes.subarray(0, 2).toString("hex");
  if (first === "fffe" || first === "3c00") return new TextDecoder("utf-16le", { fatal: true }).decode(bytes);
  if (first === "feff" || first === "003c") return new TextDecoder("utf-16be", { fatal: true }).decode(bytes);
  if (["iso88591", "latin1"].includes(declared ?? "")) return bytes.toString("latin1");
  if (["ascii", "usascii"].includes(declared ?? "")) { valid(bytes.every(byte => byte < 128)); return bytes.toString("ascii"); }
  valid(!declared || declared === "utf8"); return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
function readXml(bytes: Buffer, image: (attributes: Record<string, string>) => void, tables = false): XmlNode[] {
  const parser = new SaxesParser({ xmlns: false }), stack: { bindings: Map<string, string>; node?: XmlNode; lastTable?: XmlNode }[] = [], result: XmlNode[] = [];
  parser.on("error", error => { throw error; }); parser.on("doctype", () => { throw new Error("XML document types are forbidden"); });
  parser.on("opentag", tag => {
    valid(stack.length < 128); if (tag.name === "image" && tag.attributes.src) image(tag.attributes);
    const parent = stack.at(-1), bindings = new Map(parent?.bindings ?? []);
    if (parent) parent.lastTable = undefined;
    for (const [name, value] of Object.entries(tag.attributes)) if (name === "xmlns" || name.startsWith("xmlns:")) bindings.set(name === "xmlns" ? "" : name.slice(6), value);
    const namespace = bindings.get("") ?? "", node = tables && (parent?.node || tag.name === "table" && !namespace) ? { name: tag.name, namespace, attributes: { ...tag.attributes }, children: [], bindings } as XmlNode : undefined;
    if (node && parent?.node) parent.node.children.push(node); stack.push({ bindings, node });
  });
  const text = (value: string) => { const frame = stack.at(-1); frame?.node?.children.push(value); if (frame?.lastTable) frame.lastTable.tail = (frame.lastTable.tail ?? "") + value; }; parser.on("text", text); parser.on("cdata", text);
  parser.on("closetag", () => { const node = stack.pop()?.node, table = node?.name === "table" && !node.namespace ? node : undefined, parent = stack.at(-1); if (table) result.push(table); if (parent) parent.lastTable = table; });
  parser.write(xmlSource(bytes)).close(); return result;
}
export function jsonSize(value: unknown, spaced = false, depth = 0): number {
  valid(depth <= 128); let extra = 0;
  if (Array.isArray(value)) extra = Math.max(0, value.length - 1) + value.reduce((sum, item) => sum + jsonSize(item, true, depth + 1), 0);
  else if (record(value)) extra = Object.keys(value).length + Math.max(0, Object.keys(value).length - 1) + Object.values(value).reduce<number>((sum, item) => sum + jsonSize(item, true, depth + 1), 0);
  return depth ? extra : characters(JSON.stringify(value)) + (spaced ? extra : 0);
}
export function verifySourcePng(bytes: Buffer): void {
  let offset = 8, frames = 0, declared = 1, sawData = false, defaultFrame = false, ended = false;
  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset), kind = bytes.subarray(offset + 4, offset + 8).toString("ascii"), end = offset + 8 + size;
    valid(end + 4 <= bytes.length && crc32(bytes.subarray(offset + 4, end)) === bytes.readUInt32BE(end));
    if (kind === "acTL") { valid(size === 8); declared = bytes.readUInt32BE(offset + 8); valid(declared > 0); }
    if (kind === "fcTL") { valid(size === 26); if (!frames && sawData) defaultFrame = true; frames++; }
    if (kind === "IDAT") sawData = true;
    invariant(declared + Number(defaultFrame) <= 1 && frames + Number(defaultFrame) <= 1, "IMAGE_MULTIFRAME_UNSUPPORTED", "Multi-frame source images are not supported");
    offset = end + 4; if (kind === "IEND") { ended = true; break; }
  }
  valid(ended);
}
export function verifySourceJpeg(bytes: Buffer): void {
  let offset = 2;
  while (offset + 1 < bytes.length) {
    valid(bytes[offset++] === 255); while (bytes[offset] === 255) offset++; const marker = bytes[offset++]; if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd8) continue;
    valid(offset + 2 <= bytes.length); const size = bytes.readUInt16BE(offset); valid(size >= 2 && offset + size <= bytes.length);
    if (marker === 0xe2 && bytes.subarray(offset + 2, offset + 6).toString("binary") === "MPF\0") {
      const tiff = bytes.subarray(offset + 6, offset + size), order = tiff.subarray(0, 2).toString(); valid(tiff.length >= 8 && ["II", "MM"].includes(order));
      const short = (at: number) => order === "II" ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at), integer = (at: number) => order === "II" ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at);
      valid(short(2) === 42); const directory = integer(4); valid(directory + 2 <= tiff.length); const count = short(directory); valid(directory + 2 + count * 12 <= tiff.length); let frames: number | undefined;
      for (let index = 0; index < count; index++) { const entry = directory + 2 + index * 12; if (short(entry) === 0xb001) { valid(frames === undefined && short(entry + 2) === 4 && integer(entry + 4) === 1); frames = integer(entry + 8); } }
      valid(frames !== undefined && frames > 0); invariant(frames === 1, "IMAGE_MULTIFRAME_UNSUPPORTED", "Multi-picture source images are not supported");
    }
    offset += size;
  }
}

/** Provider ZIPs remain inert evidence; members are never extracted to filesystem paths. */
export class TencentBundle {
  readonly limits: TencentBundleLimits;
  pages: TencentPage[] = [];
  private constructor(readonly archive: BoundedZip, readonly options: TencentBundleOptions) { this.limits = { ...TENCENT_BUNDLE_LIMITS, ...options.limits }; }
  static async open(bytes: Uint8Array, options: TencentBundleOptions): Promise<TencentBundle> {
    let archive: BoundedZip | undefined;
    try {
      options.signal?.throwIfAborted();
      valid(Number.isSafeInteger(options.pageCount) && options.pageCount >= 0 && options.pageCount <= 300 && (options.resultType === undefined || [2, 9].includes(options.resultType)));
      archive = await BoundedZip.fromBytes(bytes, { archiveBytes: 100 * 1024 * 1024, expandedBytes: 150 * 1024 * 1024, entries: 2000, allowDirectories: true, extraCodecs: true });
      valid([...archive.entries.keys()].every(name => !/[:\\\0]/.test(name))); const bundle = new TencentBundle(archive, options);
      valid(Object.values(bundle.limits).every(value => Number.isSafeInteger(value) && value > 0)); bundle.pages = await bundle.decode(); options.signal?.throwIfAborted(); return bundle;
    } catch (error) { archive?.close(); if (options.signal?.aborted) throw options.signal.reason; if (error instanceof AppError && error.code === "TENCENT_RESULT_INVALID") throw error; throw new AppError("TENCENT_RESULT_INVALID", "Tencent result archive is invalid or uses an unsupported layout"); }
  }
  close(): void { this.archive.close(); }
  private async read(name: string, limit = PAGE_BYTES): Promise<Buffer> { this.options.signal?.throwIfAborted(); const bytes = await this.archive.read(name, limit); this.options.signal?.throwIfAborted(); return bytes; }
  private async decode(): Promise<TencentPage[]> {
    const names = [...this.archive.entries.keys()];
    if (this.options.resultType === 2) {
      const members = names.filter(name => name.endsWith("_md_full.md")); if (!members.length && this.options.allowEmpty) return []; valid(members.length === 1);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(await this.read(members[0])); if (!trim(text) && this.options.allowEmpty) return [];
      valid(trim(text) && characters(text) <= this.limits.maxTotalInputChars); return [{ page: 0, format: "markdown", elements: [{ type: 2, text_info: { content: text } }], figures: [] }];
    }
    const images = new Map<string, string>();
    for (const name of names.filter(name => name.endsWith("_xml_full.xml"))) readXml(await this.read(name), attributes => {
      const match = /^p-(\p{Nd}+)$/u.exec(attributes.id ?? ""); valid(match && /^\p{Nd}+$/u.test(attributes["page-numbers"] ?? "") && this.archive.entries.has(attributes.src) && /\.(png|jpe?g)$/i.test(attributes.src));
      const key = `${digits(attributes["page-numbers"])}:${digits(match![1])}`; valid(!images.has(key)); images.set(key, attributes.src);
    });
    const imagePaths = new Set([...images].map(([key, member]) => `${key.split(":")[0]}:${member}`)), pages = new Map<number, TencentPage>(); let textSize = 0, tables: Map<string, string[]> | undefined;
    for (const name of names) {
      const match = /^.*_ocr_page(\p{Nd}+)\.json$/u.exec(name.split("/").at(-1)!); if (!match) continue;
      const page = digits(match[1]); valid(!pages.has(page) && page < this.options.pageCount); const value = parseJson(await this.read(name)); valid(record(value)); const data = value as Record<string, unknown>;
      if (["table_name", "fields", "rows"].every(key => Object.hasOwn(data, key))) {
        valid(typeof data.table_name === "string" && Array.isArray(data.fields) && data.fields.length <= 10000 && data.fields.every(record) && Array.isArray(data.rows) && data.rows.length <= 10000 && data.rows.every(row => record(row) && Array.isArray(row.cells) && row.cells.length <= 10000 && row.cells.every(record)));
        if (!tables) { tables = new Map(); let size = 0; for (const layout of names.filter(name => name.endsWith("_xml_full.xml"))) { const bytes = await this.read(layout); size += bytes.length; valid(size <= Math.min(PAGE_BYTES, this.limits.maxTotalInputChars * 4)); for (const node of readXml(bytes, () => {}, true)) { const caption = node.children.find(child => typeof child !== "string" && child.name === "caption" && !child.namespace); if (caption && typeof caption !== "string") { const key = trim(xmlText(caption)), values = tables.get(key) ?? []; values.push(serializeXml(node)); tables.set(key, values); } } } }
        const caption = Object.hasOwn(data, "caption") ? data.caption : data.table_name, layouts = typeof caption === "string" ? tables.get(trim(caption)) ?? [] : [], element: Record<string, unknown> = { type: 3, table_info: data };
        if (layouts.length === 1) element.layout_xml = layouts[0]; textSize += jsonSize(element, true); valid(textSize <= this.limits.maxTotalInputChars);
        const figures = [...images].filter(([key]) => Number(key.split(":")[0]) === page).map(([key, imageMember]): TencentFigure => ({ elementIndex: Number(key.split(":")[1]), kind: "image", bbox: null, imageMember }));
        pages.set(page, { page, format: "table", elements: [element], figures }); continue;
      }
      const { width, height, elements } = data;
      valid(Number.isSafeInteger(width) && Number.isSafeInteger(height) && Number(width) > 0 && Number(height) > 0 && Number(width) * Number(height) <= this.limits.maxVisionPagePixels && Array.isArray(elements) && elements.length <= 10000 && elements.every(record));
      const rows = elements as Record<string, unknown>[], figures: TencentFigure[] = [], ids = new Set<number>();
      rows.forEach((element, position) => {
        if (!Object.hasOwn(element, "figure_info") && !Object.hasOwn(element, "table_info")) return;
        const identifier = element.index === undefined ? position : element.index; valid(Number.isSafeInteger(identifier) && Number(identifier) >= 0 && !ids.has(Number(identifier))); ids.add(Number(identifier)); let member = images.get(`${page}:${identifier}`) ?? null;
        const info = element.figure_info === undefined ? {} : element.figure_info; valid(record(info));
        if (Object.hasOwn(info as object, "path")) { valid(typeof object(info).path === "string" && imagePaths.has(`${page}:${object(info).path}`)); member = String(object(info).path); }
        const figure: TencentFigure = { elementIndex: Number(identifier), bbox: elementBox(element, Number(width), Number(height)), kind: Object.hasOwn(element, "table_info") ? "table" : "image", imageMember: member };
        if (Object.hasOwn(element, "figure_info")) { const crop = labelCropBox(element, rows, Number(width), Number(height)); if (crop) figure.cropBbox = crop; } figures.push(figure);
      });
      textSize += jsonSize(rows); valid(textSize <= this.limits.maxTotalInputChars); pages.set(page, { page, width: Number(width), height: Number(height), elements: rows, figures });
    }
    valid(pages.size || this.options.allowEmpty); return [...pages.values()].sort((a, b) => a.page - b.page);
  }
  async image(member: string): Promise<{ bytes: Buffer; mediaType: "image/png" | "image/jpeg" }> {
    try {
      const entry = this.archive.entries.get(member); valid(entry); invariant(entry!.uncompressedSize <= Math.min(this.limits.visionMaxBytes, 25 * 1024 * 1024), "TENCENT_RESULT_TOO_LARGE", "Tencent subimage exceeds its limit");
      const bytes = await this.read(member, Math.min(this.limits.visionMaxBytes, 25 * 1024 * 1024)), mediaType = bytes.subarray(0, 4).equals(Buffer.from([137, 80, 78, 71])) ? "image/png" : "image/jpeg";
      valid(mediaType === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255);
      const image = sharp(bytes, { limitInputPixels: false, failOn: "warning" }).timeout({ seconds: 5 });
      try { const info = await image.metadata(), width = info.width ?? 0, height = info.height ?? 0; invariant(width > 0 && height > 0 && width <= 16384 && height <= 16384 && width * height <= Math.min(this.limits.maxVisionPagePixels, 32000000), "IMAGE_TOO_LARGE", "Tencent subimage exceeds dimension or pixel limits"); invariant((info.pages ?? 1) === 1, "IMAGE_MULTIFRAME_UNSUPPORTED", "Multi-frame source images are not supported"); if (mediaType === "image/png") verifySourcePng(bytes); else verifySourceJpeg(bytes); } finally { image.destroy(); }
      await validateImage(bytes, mediaType); this.options.signal?.throwIfAborted(); return { bytes, mediaType };
    } catch (error) { if (this.options.signal?.aborted) throw this.options.signal.reason; if (error instanceof AppError && ["TENCENT_RESULT_TOO_LARGE", "IMAGE_TOO_LARGE", "IMAGE_MULTIFRAME_UNSUPPORTED"].includes(error.code)) throw error; throw new AppError("TENCENT_RESULT_INVALID", "Tencent subimage is invalid"); }
  }
}
