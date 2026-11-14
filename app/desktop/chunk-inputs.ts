import type { ArtifactReference } from "../src/contracts.generated.js";
import { AiStorage } from "./ai-storage.js";
import { hash } from "./assets.js";
import { parseJson } from "./document-contract.js";
import type { DocumentStageContext } from "./document-runtime.js";
import type { DocumentRecord } from "./document-tasks.js";
import { AppError, invariant } from "./errors.js";
import { executionJson } from "./graph-store.js";
import { canonical } from "./questions.js";
import { sourcePresencePlan, splitChunkPlan, type ChunkSourceOptions, type ChunkSpan, type SourcePresenceHint } from "./source-chunks.js";
import { SourceText } from "./source-text.js";

export interface ChunkInputsManifest {
  version: 1; taskId: string; sourceSha256: string; textRef: ArtifactReference; policy: Required<ChunkSourceOptions>;
  spans: ChunkSpan[]; headers: (string | null)[]; nodeCounts: (number | null)[];
  presence: (Record<string, SourcePresenceHint> | null)[]; chunkRefs: ArtifactReference[];
}
export class ChunkInputs {
  constructor(readonly storage: AiStorage) {}
  private expected(task: DocumentRecord, textRef: ArtifactReference, options: ChunkSourceOptions) {
    invariant(textRef?.mediaType === "text/plain" && typeof textRef.objectKey === "string" && textRef.objectKey.startsWith(`practiq-agent/artifacts/${task.input.document.sha256}/text/`), "CHUNK_INPUTS_INVALID", "Model chunks require the original task's verified text artifact");
    const bytes = this.storage.artifact(textRef); let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new AppError("DOCUMENT_ENCODING_INVALID", "Stored model text is not UTF-8"); }
    const source = new SourceText(text); invariant(source.length <= 2_000_000, "TENCENT_SOURCE_TOO_LARGE", "Stored text exceeds the document character limit");
    const policy: Required<ChunkSourceOptions> = { sourceType: options.sourceType ?? task.input.document.sourceType, tabularRowsSafe: options.tabularRowsSafe ?? false, complete: options.complete ?? true };
    invariant(typeof policy.sourceType === "string" && policy.sourceType.length > 0 && policy.sourceType.length <= 32 && typeof policy.tabularRowsSafe === "boolean" && typeof policy.complete === "boolean", "CHUNK_INPUTS_INVALID", "Invalid model chunk source policy");
    const plan = splitChunkPlan(text, undefined, policy), headers = plan.spans.map(span => span.start ? plan.header : null), presence = sourcePresencePlan(text, plan.spans, policy);
    return { source, metadata: { version: 1 as const, taskId: task.id, sourceSha256: task.input.document.sha256, textRef, policy, spans: plan.spans, headers, nodeCounts: plan.nodeCounts, presence } };
  }
  private verify(input: unknown, expected: ReturnType<ChunkInputs["expected"]>): ChunkInputsManifest {
    invariant(input !== null && typeof input === "object" && !Array.isArray(input), "CHUNK_INPUTS_INVALID", "Invalid saved model chunk manifest");
    const { chunkRefs, ...metadata } = input as ChunkInputsManifest;
    invariant(canonical(metadata) === canonical(expected.metadata) && Array.isArray(chunkRefs) && chunkRefs.length === expected.metadata.spans.length, "CHUNK_INPUTS_INVALID", "Saved model chunks differ from the source or planning policy");
    for (const [index, reference] of chunkRefs.entries()) {
      const span = metadata.spans[index], bytes = Buffer.from(expected.source.slice(span.start, span.end));
      invariant(reference?.mediaType === "text/plain" && typeof reference.objectKey === "string" && reference.objectKey.startsWith(`practiq-agent/artifacts/${metadata.sourceSha256}/chunk/${index}-`) && reference.sha256 === hash(bytes) && reference.sizeBytes === bytes.length, "CHUNK_INPUTS_INVALID", "Saved model chunk differs from its original source range"); this.storage.artifact(reference);
    } return input as ChunkInputsManifest;
  }
  read(context: DocumentStageContext, manifest: ArtifactReference, textRef: ArtifactReference, options: ChunkSourceOptions = {}): ChunkInputsManifest {
    context.execution.guard(); return this.readSaved(context.task, manifest, textRef, options);
  }
  readSaved(task: DocumentRecord, manifest: ArtifactReference, textRef: ArtifactReference, options: ChunkSourceOptions = {}): ChunkInputsManifest {
    const expected = this.expected(task, textRef, options);
    invariant(manifest?.mediaType === "application/json" && typeof manifest.objectKey === "string" && manifest.objectKey.startsWith(`practiq-agent/artifacts/${expected.metadata.sourceSha256}/chunk-inputs/`), "CHUNK_INPUTS_INVALID", "Chunk manifest belongs to another source or artifact kind");
    return this.verify(parseJson(this.storage.artifact(manifest)), expected);
  }
  async prepare(context: DocumentStageContext, textRef: ArtifactReference, options: ChunkSourceOptions = {}): Promise<{ manifest: ArtifactReference; value: ChunkInputsManifest; artifacts: ArtifactReference[] }> {
    context.execution.guard(); const namespace = ["document_tasks", context.task.id, "chunk_inputs"], previous = await context.store.get(namespace, "source");
    if (previous) {
      invariant(Object.keys(previous.value).length === 1 && Object.hasOwn(previous.value, "manifest"), "CHUNK_INPUTS_INVALID", "Invalid durable model chunk receipt");
      const manifest = previous.value.manifest as ArtifactReference, value = this.read(context, manifest, textRef, options); return { manifest, value, artifacts: [manifest, ...value.chunkRefs] };
    }
    context.execution.guard(); const expected = this.expected(context.task, textRef, options), chunkRefs: ArtifactReference[] = [];
    for (const [index, span] of expected.metadata.spans.entries()) { context.execution.guard(); chunkRefs.push(await this.storage.putArtifact(Buffer.from(expected.source.slice(span.start, span.end)), expected.metadata.sourceSha256, "chunk", index, "text/plain")); }
    const value: ChunkInputsManifest = { ...expected.metadata, chunkRefs }; this.verify(value, expected);
    const manifest = await this.storage.putArtifact(Buffer.from(executionJson(value)), expected.metadata.sourceSha256, "chunk-inputs", 0, "application/json"); context.execution.guard();
    await context.store.update(namespace, "source", previous => { invariant(previous === null || canonical(previous) === canonical({ manifest }), "CHUNK_INPUTS_INVALID", "Model chunk preparation changed before its receipt committed"); return { manifest }; });
    return { manifest, value, artifacts: [manifest, ...chunkRefs] };
  }
}
