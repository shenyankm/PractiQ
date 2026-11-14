import { SaxesParser } from "saxes";
import { AppError, invariant } from "./errors.js";
import { xmlSource } from "./tencent-bundle.js";
import { BoundedZip } from "./zip.js";

/** Visibility metadata only; cell content and every original source byte stay authoritative. */
export async function visibleWorkbook(bytes: Buffer, maxSheets: number, signal: AbortSignal): Promise<{ bytes: Buffer; sheets: string[] }> {
  signal.throwIfAborted(); invariant(Number.isSafeInteger(maxSheets) && maxSheets >= 1 && maxSheets <= 300, "OFFICE_INPUT_INVALID", "Invalid workbook sheet limit"); let archive: BoundedZip | undefined;
  try {
    archive = await BoundedZip.fromBytes(bytes, { archiveBytes: 25 * 1024 * 1024, expandedBytes: 100 * 1024 * 1024, entries: 10000, allowDirectories: true, extraCodecs: true });
    invariant(archive.entries.has("[Content_Types].xml") && archive.entries.has("xl/workbook.xml") && ![...archive.entries.keys()].some(name => name.toLowerCase().endsWith("vbaproject.bin")), "OFFICE_INPUT_INVALID", "Invalid or macro-enabled workbook");
    const source = xmlSource(await archive.read("xl/workbook.xml", 2 * 1024 * 1024)), sheets: string[] = [], replacements: { start: number; end: number }[] = [], parser = new SaxesParser({ xmlns: true }); let depth = 0, namespace: string | undefined, state: { value: string; start: number; end: number } | undefined;
    parser.on("error", error => { throw error; }); parser.on("doctype", () => { throw new AppError("OFFICE_INPUT_INVALID", "Workbook document types are forbidden"); });
    parser.on("opentagstart", () => { state = undefined; });
    parser.on("attribute", attribute => { if (attribute.name === "state") { const end = parser.position - 1, quote = source[end], start = source.lastIndexOf(quote, end - 1) + 1; invariant(["\"", "'"].includes(quote) && start > 0, "OFFICE_INPUT_INVALID", "Invalid workbook attribute position"); state = { value: attribute.value, start, end }; } });
    parser.on("opentag", tag => {
      invariant(++depth <= 128, "OFFICE_INPUT_INVALID", "Workbook XML exceeds its nesting limit");
      if (namespace === undefined) { invariant(tag.local === "workbook", "OFFICE_INPUT_INVALID", "Workbook metadata has the wrong root"); namespace = tag.uri; }
      if (tag.local === "sheet" && tag.uri === namespace) { invariant(sheets.length < maxSheets, "OFFICE_OUTPUT_LIMIT", "Workbook exceeds the sheet limit"); const name = tag.attributes.name; sheets.push(name && typeof name !== "string" ? name.value : ""); if (state && ["hidden", "veryHidden"].includes(state.value)) replacements.push({ start: state.start, end: state.end }); }
    }); parser.on("closetag", () => { depth--; }); parser.write(source).close();
    invariant(namespace !== undefined, "OFFICE_INPUT_INVALID", "Workbook metadata is empty"); signal.throwIfAborted();
    if (!replacements.length) { for (const entry of archive.entries.values()) { await archive.read(entry.fileName, 100 * 1024 * 1024); signal.throwIfAborted(); } return { bytes, sheets }; }
    let visible = source; for (const range of replacements.reverse()) visible = visible.slice(0, range.start) + "visible" + visible.slice(range.end);
    visible = visible.replace(/^(<\?xml\s[^?]*\bencoding\s*=\s*)(["'])[^"']*\2/i, '$1"utf-8"');
    return { bytes: await archive.replace(new Map([["xl/workbook.xml", Buffer.from(visible)]]), 25 * 1024 * 1024, signal), sheets };
  } catch (error) { if (signal.aborted) throw signal.reason; if (error instanceof AppError && ["OFFICE_INPUT_INVALID", "OFFICE_OUTPUT_LIMIT"].includes(error.code)) throw error; throw new AppError(error instanceof AppError && ["LOCAL_ARCHIVE_TOO_LARGE", "LOCAL_BACKUP_EXPANDED_TOO_LARGE"].includes(error.code) ? "OFFICE_OUTPUT_LIMIT" : "OFFICE_INPUT_INVALID", "Workbook visibility preparation did not complete"); }
  finally { archive?.close(); }
}
