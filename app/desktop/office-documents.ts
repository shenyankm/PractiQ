import type { ArtifactReference, DocumentReference } from "../src/contracts.generated.js";
import { AiStorage } from "./ai-storage.js";
import { hash } from "./assets.js";
import { parseJson } from "./document-contract.js";
import type { DocumentStageContext } from "./document-runtime.js";
import type { DocumentStageOutput } from "./document-tasks.js";
import { invariant } from "./errors.js";
import { executionJson } from "./graph-store.js";
import { officePreparation } from "./office-preparation.js";
import { canonical } from "./questions.js";
import { recognizePages } from "./recognized-pages.js";
import { TencentResults } from "./tencent-results.js";
import type { RecognizedText, TextInputLimits } from "./text-documents.js";
import { PAGE_SELECTION_WARNING, sourceIndexes } from "./source-selection.js";
import { tencentInputLimit } from "./tencent.js";

export const OFFICE_SOURCES = ["doc", "docx", "ppt", "pptx", "xls", "xlsx"] as const;
export const officeSource = (type: string): type is typeof OFFICE_SOURCES[number] => (OFFICE_SOURCES as readonly string[]).includes(type);
export interface OfficePart { reference: ArtifactReference; preparation: "visible_excel_sheets" | "visible_powerpoint_slides" }
interface OfficePlan { version: 2; taskId: string; source: DocumentReference; policy: TextInputLimits; executionFingerprint: string; submission: ArtifactReference | DocumentReference; sheets: string[]; slides: string[]; preparation: OfficePart["preparation"] | null }
export type RecognizedOffice = Omit<RecognizedText, "version" | "inputParts"> & { version: 3; inputParts: OfficePart[]; pageRefs: ArtifactReference[]; prepareManifest: ArtifactReference };

/** Office content is recognized by Tencent; local work only validates containers and visibility metadata. */
export class OfficeDocuments {
  constructor(readonly storage: AiStorage, readonly results: TencentResults, readonly limits: TextInputLimits) {}
  private async expected(context: DocumentStageContext) {
    context.execution.guard(); const source = context.task.input.document; invariant(officeSource(source.sourceType), "DOCUMENT_SOURCE_TYPE_MISMATCH", "Office stages require an Office document");
    const limit = context.config.preferences.tencentCos.enabled ? tencentInputLimit(source.sourceType, true) : this.limits.inputBytes;
    invariant(source.sizeBytes <= limit, "OFFICE_EXPORT_PDF_REQUIRED", "Office input exceeds the current size limit; export it as a PDF and import the PDF");
    const prepared = ["xlsx", "pptx", "ppt"].includes(source.sourceType) ? await officePreparation(() => this.storage.source(source), source.sourceType, this.limits.maxParts, context.signal) : { bytes: this.storage.source(source), sheets: [], slides: [], unchanged: true };
    context.execution.guard(); invariant(prepared.bytes.length <= limit, "OFFICE_EXPORT_PDF_REQUIRED", "Prepared Office input exceeds the current size limit; export it as a PDF and import the PDF");
    const powerpoint = ["ppt", "pptx"].includes(source.sourceType), kind = powerpoint ? "visible-slides" : "visible-workbook", preparation: OfficePart["preparation"] | null = prepared.unchanged ? null : powerpoint ? "visible_powerpoint_slides" : "visible_excel_sheets";
    return { source, ...prepared, kind, preparation };
  }
  private async verify(value: unknown, context: DocumentStageContext): Promise<OfficePlan> {
    const expected = await this.expected(context), plan = value as OfficePlan;
    invariant(plan && Object.keys(plan).length === 9 && ["version", "taskId", "source", "policy", "executionFingerprint", "submission", "sheets", "slides", "preparation"].every(key => Object.hasOwn(plan, key)) && plan.version === 2 && plan.taskId === context.task.id && canonical(plan.source) === canonical(expected.source) && canonical(plan.policy) === canonical(this.limits) && plan.executionFingerprint === context.task.executionFingerprint && canonical(plan.sheets) === canonical(expected.sheets) && canonical(plan.slides) === canonical(expected.slides) && plan.preparation === expected.preparation, "TENCENT_INPUTS_INVALID", "Office preparation belongs to another source, execution or policy");
    if (expected.preparation) { const reference = plan.submission; invariant(!("sourceType" in reference) && reference.objectKey.startsWith(`practiq-agent/artifacts/${expected.source.sha256}/${expected.kind}/0-`) && reference.mediaType === expected.source.mediaType && reference.sha256 === hash(expected.bytes) && this.storage.artifact(reference).equals(expected.bytes), "TENCENT_INPUTS_INVALID", "Office derivative differs from its original visibility-only snapshot"); }
    else invariant(canonical(plan.submission) === canonical(expected.source), "TENCENT_INPUTS_INVALID", "Unmodified Office recognition must retain its immutable original");
    return plan;
  }
  async prepare(context: DocumentStageContext): Promise<DocumentStageOutput> {
    const namespace = ["document_tasks", context.task.id, "tencent_inputs"], previous = await context.store.get(namespace, "source"); let plan: OfficePlan, manifest: ArtifactReference;
    if (previous) {
      invariant(Object.keys(previous.value).length === 1, "TENCENT_INPUTS_INVALID", "Invalid Office input receipt"); manifest = previous.value.manifest as ArtifactReference;
      invariant(manifest?.mediaType === "application/json" && manifest.objectKey.startsWith(`practiq-agent/artifacts/${context.task.input.document.sha256}/tencent-inputs/`), "TENCENT_INPUTS_INVALID", "Invalid Office input manifest"); plan = await this.verify(parseJson(this.storage.artifact(manifest)), context);
    } else {
      const expected = await this.expected(context), submission = expected.preparation ? await this.storage.putArtifact(expected.bytes, expected.source.sha256, expected.kind, 0, expected.source.mediaType) : expected.source;
      context.execution.guard(); plan = { version: 2, taskId: context.task.id, source: expected.source, policy: { ...this.limits }, executionFingerprint: context.task.executionFingerprint!, submission, sheets: expected.sheets, slides: expected.slides, preparation: expected.preparation };
      manifest = await this.storage.putArtifact(Buffer.from(executionJson(plan)), expected.source.sha256, "tencent-inputs", 0, "application/json"); context.execution.guard(); await context.store.update(namespace, "source", previous => { invariant(previous === null || canonical(previous) === canonical({ manifest }), "TENCENT_INPUTS_INVALID", "Office preparation changed before receipt publication"); return { manifest }; });
    }
    return { manifest, artifacts: [manifest, ...("sourceType" in plan.submission ? [] : [plan.submission])] };
  }
  async recognize(context: DocumentStageContext): Promise<DocumentStageOutput> {
    context.execution.guard(); const source = context.task.input.document, stage = context.task.outputs.prepare, manifest = stage?.manifest;
    invariant(manifest && stage.artifacts.some(reference => canonical(reference) === canonical(manifest)), "TENCENT_INPUTS_INVALID", "Office recognition requires its completed preparation");
    const saved = await context.store.get(["document_tasks", context.task.id, "tencent_inputs"], "source"); invariant(saved && canonical(saved.value) === canonical({ manifest }), "TENCENT_INPUTS_INVALID", "Office preparation differs from its durable receipt");
    const plan = await this.verify(parseJson(this.storage.artifact(manifest)), context); invariant(officeSource(source.sourceType), "DOCUMENT_SOURCE_TYPE_MISMATCH", "Invalid Office source");
    if (!("sourceType" in plan.submission)) invariant(stage.artifacts.some(reference => canonical(reference) === canonical(plan.submission)), "INVALID_REFERENCE", "Office derivative is not owned by its preparation stage");
    const recognized = await recognizePages(this.storage, this.results, context, [{ reference: plan.submission, sourceType: source.sourceType, count: null }], this.limits), warnings: string[] = []; let truncated = recognized.truncated;
    if (["xls", "xlsx"].includes(source.sourceType)) warnings.push("Excel sheets, including hidden sheets and merged layouts, require fidelity review against the original workbook.");
    if (["ppt", "pptx"].includes(source.sourceType)) warnings.push("PowerPoint slides, including hidden slides, require fidelity review against the original presentation.");
    if (recognized.pages.length < plan.slides.length) { truncated = true; warnings.push("Tencent returned fewer pages than declared presentation slides; retain the original and review omitted or hidden slides."); }
    if (recognized.pages.length >= this.limits.maxParts) { truncated = true; warnings.push("Office recognition reached the configured page limit; review the original for additional content."); }
    if (recognized.truncated) warnings.push("Tencent parsing contains failed or missing pages; retain human review.");
    const returnedSheets = new Set(recognized.pages.flatMap(page => "elements" in page && page.format === "table" ? page.elements.flatMap(element => element.table_info !== null && typeof element.table_info === "object" ? [String((element.table_info as Record<string, unknown>).table_name)] : []) : []));
    if (plan.sheets.length && !plan.sheets.every(sheet => returnedSheets.has(sheet))) { truncated = true; warnings.push("Tencent native tables do not establish coverage of every workbook sheet. Some sheet names are absent; review the original workbook for omitted questions, tables and images."); }
    sourceIndexes(context.task, "vision_parse", recognized.ocrPageRefs.length); if (context.task.input.pages) warnings.push(PAGE_SELECTION_WARNING);
    const value: RecognizedOffice = { version: 3, source, textRef: null, ocrPageRefs: recognized.ocrPageRefs, inputParts: plan.preparation ? [{ reference: plan.submission, preparation: plan.preparation }] : [], warnings, truncated, chunkManifest: null, pageRefs: recognized.ocrPageRefs, prepareManifest: manifest }, result = await this.storage.putArtifact(Buffer.from(executionJson(value)), source.sha256, "recognized-text", 0, "application/json"); context.execution.guard();
    return { manifest: result, artifacts: [result, ...stage.artifacts, ...recognized.artifacts] };
  }
}
