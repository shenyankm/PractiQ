import { posix } from "node:path";
import { SaxesParser, type SaxesTagNS } from "saxes";
import { AppError, invariant } from "./errors.js";
import { xmlSource } from "./tencent-bundle.js";
import { BoundedZip, safeZipName } from "./zip.js";

const presentation = ["http://schemas.openxmlformats.org/presentationml/2006/main", "http://purl.oclc.org/ooxml/presentationml/main"], relationships = ["http://schemas.openxmlformats.org/package/2006/relationships", "http://purl.oclc.org/ooxml/package/relationships"], documentRelationships = ["http://schemas.openxmlformats.org/officeDocument/2006/relationships", "http://purl.oclc.org/ooxml/officeDocument/relationships"];
const attribute = (tag: SaxesTagNS, name: string): string => { const value = tag.attributes[name]; return value && value.uri === "" ? value.value : ""; };

/** Change slide visibility only; the declared order, slide content and original file remain intact. */
export async function visibleSlides(bytes: Buffer, maxSlides: number, signal: AbortSignal): Promise<{ bytes: Buffer; slides: string[] }> {
  signal.throwIfAborted(); invariant(Number.isSafeInteger(maxSlides) && maxSlides >= 1 && maxSlides <= 300, "OFFICE_INPUT_INVALID", "Invalid presentation slide limit"); let archive: BoundedZip | undefined;
  try {
    archive = await BoundedZip.fromBytes(bytes, { archiveBytes: 25 * 1024 * 1024, expandedBytes: 100 * 1024 * 1024, entries: 10000, allowDirectories: true, extraCodecs: true });
    invariant(archive.entries.has("[Content_Types].xml") && ![...archive.entries.keys()].some(name => name.toLowerCase().endsWith("vbaproject.bin")), "OFFICE_INPUT_INVALID", "Invalid or macro-enabled presentation");
    const metadata = async (name: string, root: string, namespaces: string[], visit: (tag: SaxesTagNS, parents: SaxesTagNS[]) => void) => {
      signal.throwIfAborted(); const source = xmlSource(await archive!.read(name, 2 * 1024 * 1024)), parser = new SaxesParser({ xmlns: true }), parents: SaxesTagNS[] = []; let show: { value: string; start: number; end: number } | undefined;
      parser.on("error", error => { throw error; }); parser.on("doctype", () => { throw new AppError("OFFICE_INPUT_INVALID", "Presentation document types are forbidden"); });
      parser.on("attribute", value => { if (!parents.length && value.name === "show") { const end = parser.position - 1, quote = source[end], start = source.lastIndexOf(quote, end - 1) + 1; invariant(["\"", "'"].includes(quote) && start > 0, "OFFICE_INPUT_INVALID", "Invalid slide visibility attribute"); show = { value: value.value, start, end }; } });
      parser.on("opentag", tag => { invariant(parents.length < 128, "OFFICE_INPUT_INVALID", "Presentation XML exceeds its nesting limit"); if (!parents.length) invariant(tag.local === root && namespaces.includes(tag.uri), "OFFICE_INPUT_INVALID", "Presentation metadata has the wrong root"); visit(tag, parents); parents.push(tag); });
      parser.on("closetag", () => { parents.pop(); }); parser.write(source).close(); signal.throwIfAborted(); return { source, show };
    };
    const ids: string[] = [], numericIds = new Set<string>();
    await metadata("ppt/presentation.xml", "presentation", presentation, (tag, parents) => {
      if (parents.length !== 2 || parents[1].local !== "sldIdLst" || tag.local !== "sldId" || tag.uri !== parents[0].uri || parents[1].uri !== tag.uri) return;
      const relation = Object.values(tag.attributes).find(value => value.local === "id" && documentRelationships.includes(value.uri))?.value, id = attribute(tag, "id");
      invariant(relation && relation.length <= 255 && !ids.includes(relation) && /^[0-9]+$/.test(id) && Number(id) >= 256 && Number(id) <= 2147483647 && !numericIds.has(String(Number(id))), "OFFICE_INPUT_INVALID", "Invalid or duplicate presentation slide identity");
      invariant(ids.length < maxSlides, "OFFICE_OUTPUT_LIMIT", "Presentation exceeds the slide limit"); ids.push(relation); numericIds.add(String(Number(id)));
    });
    invariant(ids.length > 0, "OFFICE_INPUT_INVALID", "Presentation contains no declared slides");
    const links = new Map<string, { target: string; type: string; mode: string }>();
    await metadata("ppt/_rels/presentation.xml.rels", "Relationships", relationships, (tag, parents) => {
      if (parents.length !== 1 || tag.local !== "Relationship" || tag.uri !== parents[0].uri) return;
      const id = attribute(tag, "Id"); invariant(id && !links.has(id), "OFFICE_INPUT_INVALID", "Invalid or duplicate presentation relationship"); links.set(id, { target: attribute(tag, "Target"), type: attribute(tag, "Type"), mode: attribute(tag, "TargetMode") });
    });
    const slides: string[] = [], replacements = new Map<string, Buffer>();
    for (const id of ids) {
      const link = links.get(id); invariant(link && documentRelationships.some(namespace => link.type === `${namespace}/slide`) && ["", "Internal"].includes(link.mode), "OFFICE_INPUT_INVALID", "Slide relationship must refer to a local slide");
      const target = decodeURIComponent(link.target); invariant(target && !/[\\\0:?#]/.test(target), "OFFICE_INPUT_INVALID", "Invalid slide part URI"); const name = posix.normalize(target.startsWith("/") ? target.slice(1) : posix.join("ppt", target));
      invariant(safeZipName(name) && !name.endsWith("/") && archive.entries.has(name) && !slides.includes(name), "OFFICE_INPUT_INVALID", "Slide part is missing or duplicated"); slides.push(name);
      const { source, show } = await metadata(name, "sld", presentation, () => {});
      if (show) {
        invariant(/^[ \t\r\n]*(?:true|false|0|1)[ \t\r\n]*$/.test(show.value), "OFFICE_INPUT_INVALID", "Invalid slide visibility value");
        if (["0", "false"].includes(show.value.trim())) { let visible = source.slice(0, show.start) + "true" + source.slice(show.end); visible = visible.replace(/^(<\?xml\s[^?]*\bencoding\s*=\s*)(["'])([^"']*)\2/i, (declaration, prefix, _quote, encoding) => /^utf-?8$/i.test(encoding) ? declaration : `${prefix}"utf-8"`); replacements.set(name, Buffer.from(visible)); }
      }
    }
    if (replacements.size) return { bytes: await archive.replace(replacements, 25 * 1024 * 1024, signal), slides };
    for (const entry of archive.entries.values()) { await archive.read(entry.fileName, 100 * 1024 * 1024); signal.throwIfAborted(); } return { bytes, slides };
  } catch (error) { if (signal.aborted) throw signal.reason; if (error instanceof AppError && ["OFFICE_INPUT_INVALID", "OFFICE_OUTPUT_LIMIT"].includes(error.code)) throw error; throw new AppError(error instanceof AppError && ["LOCAL_ARCHIVE_TOO_LARGE", "LOCAL_BACKUP_EXPANDED_TOO_LARGE"].includes(error.code) ? "OFFICE_OUTPUT_LIMIT" : "OFFICE_INPUT_INVALID", "Presentation visibility preparation did not complete"); }
  finally { archive?.close(); }
}
