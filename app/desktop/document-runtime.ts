import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { DocumentTaskReceipt } from "../src/contracts.generated.js";
import type { AiSnapshot } from "./ai-settings.js";
import { SqliteCheckpoints } from "./checkpoints.js";
import { DOCUMENT_STAGES, type DocumentConfiguration, type DocumentRecord, type DocumentStage, type DocumentStageOutput, DocumentTasks } from "./document-tasks.js";
import { AppError, invariant } from "./errors.js";
import { text } from "./question-contract.js";
import { SqliteStore } from "./graph-store.js";
import { currentExecution, DocumentExecution, executionBuildFingerprint } from "./document-execution.js";
import { unreadableEvidence } from "./document-diagnostics.js";

export interface DocumentStageContext { task: DocumentRecord; config: AiSnapshot; signal: AbortSignal; store: SqliteStore; execution: DocumentExecution }
type Stage = (context: DocumentStageContext) => Promise<DocumentStageOutput>;
export type DocumentStages = Record<Exclude<DocumentStage, "answers">, Stage> & { answers?: Stage };
const State = Annotation.Root({ taskId: Annotation<string>(), inputDigest: Annotation<string>(), lastStage: Annotation<DocumentStage>(), outputs: Annotation<Partial<Record<DocumentStage, DocumentStageOutput>>>() });
const graphConfig = (id: string) => ({ configurable: { thread_id: `document:${id}` }, durability: "sync" as const, recursionLimit: 16 });
const safeCode = (error: unknown): string => error instanceof AppError && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : "DOCUMENT_RUN_FAILED";
interface Running { runId: string; controller: AbortController; done: Promise<void> }
interface Authorization { runId: string; config: AiSnapshot; controller: AbortController; stage?: DocumentStage; pending: Set<Promise<unknown>> }

/** A task is acknowledged only after a real, provider-free initial checkpoint exists. */
export class DocumentRuntime {
  private readonly running = new Map<string, Running>();
  private readonly initializing = new Map<string, Promise<void>>();
  private readonly deleting = new Map<string, Promise<{ threadId: string; deleted: true }>>();
  constructor(readonly tasks: DocumentTasks, readonly checkpoints: SqliteCheckpoints, readonly stages: DocumentStages, readonly store: SqliteStore) { tasks.bindStore(store); }
  private graph(authorization?: Authorization, initial = false) {
    const node = (stage: DocumentStage) => (state: typeof State.State) => {
      const work = (async () => {
        try {
          invariant(authorization, "INVALID_CONTROL", "Initial checkpoint creation cannot execute document stages"); authorization.stage = stage;
          const execution = currentExecution(); execution.guard();
          const task = this.tasks.stage(state.taskId, authorization.runId, stage); invariant(task.inputDigest === state.inputDigest, "TASK_CHECKPOINT_UNREADABLE", "Checkpoint belongs to another document admission");
          if (!task.outputs[stage]) { const perform = this.stages[stage]; invariant(perform, "ACTION_UNAVAILABLE", "Document stage is unavailable"); const output = await perform({ task, config: authorization.config, signal: authorization.controller.signal, store: this.store, execution }); this.tasks.saveOutput(task.id, authorization.runId, stage, output); }
          return { lastStage: stage, outputs: this.tasks.record(task.id).outputs };
        } catch (error) { throw new AppError(safeCode(error), "Document stage did not complete"); }
      })();
      authorization?.pending.add(work); void work.finally(() => authorization?.pending.delete(work)).catch(() => {}); return work;
    };
    return new StateGraph(State).addNode("prepare", node("prepare")).addNode("recognize", node("recognize")).addNode("structure", node("structure")).addNode("assemble", node("assemble")).addNode("answers", node("answers"))
      .addEdge(START, "prepare").addEdge("prepare", "recognize").addEdge("recognize", "structure").addEdge("structure", "assemble")
      .addConditionalEdges("assemble", state => this.tasks.record(state.taskId).input.generateAnswers ? "answers" : END, ["answers", END]).addEdge("answers", END)
      .compile({ checkpointer: this.checkpoints, store: this.store, ...(initial ? { interruptBefore: ["prepare" as const] } : {}) });
  }
  initialize(id: string): Promise<void> {
    const previous = this.initializing.get(id); if (previous) return previous;
    const work = this.initializeOnce(id).finally(() => this.initializing.delete(id)); this.initializing.set(id, work); return work;
  }
  private async initializeOnce(id: string): Promise<void> {
    const task = this.tasks.record(id), config = graphConfig(id), graph = this.graph(undefined, true);
    invariant(task.executionBuild === executionBuildFingerprint(), "EXECUTION_VERSION_MISMATCH", "The saved checkpoint requires its original execution build");
    if (task.checkpointId) await this.validateCheckpoint(task);
    if (!await this.checkpoints.getTuple(config)) await graph.invoke({ taskId: id, inputDigest: task.inputDigest, outputs: {} }, config);
    let saved = await graph.getState(config);
    invariant(text(saved.values, "taskId") === id && text(saved.values, "inputDigest") === task.inputDigest, "TASK_CHECKPOINT_UNREADABLE", "Saved graph belongs to another document admission");
    const stages = DOCUMENT_STAGES.filter(stage => stage !== "answers" || task.input.generateAnswers), first = stages.findIndex(stage => !task.outputs[stage]);
    if (first >= 0 && (saved.next.length !== 1 || saved.next[0] !== stages[first])) {
      await graph.updateState(config, first === 0 ? { taskId: id, inputDigest: task.inputDigest, outputs: task.outputs } : { lastStage: stages[first - 1], outputs: task.outputs }, first === 0 ? START : stages[first - 1]); saved = await graph.getState(config);
    }
    const checkpointId = saved.config.configurable?.checkpoint_id; invariant(typeof checkpointId === "string", "TASK_CHECKPOINT_UNREADABLE", "Initial document checkpoint was not persisted"); this.tasks.checkpoint(id, task.runId, checkpointId);
  }
  async validateCheckpoint(task: DocumentRecord): Promise<void> {
    if (!task.checkpointId) return;
    try {
      const saved = await this.checkpoints.getTuple({ configurable: { thread_id: `document:${task.id}`, checkpoint_id: task.checkpointId } });
      invariant(saved && saved.checkpoint.id === task.checkpointId && text(saved.checkpoint.channel_values, "taskId") === task.id && text(saved.checkpoint.channel_values, "inputDigest") === task.inputDigest, "TASK_CHECKPOINT_UNREADABLE", "Saved checkpoint is missing or belongs to another admission");
    } catch (error) { if (!unreadableEvidence(error)) throw error; throw new AppError("TASK_CHECKPOINT_UNREADABLE", "Saved checkpoint cannot be read; existing evidence remains unchanged"); }
  }
  async create(input: unknown, config: DocumentConfiguration): Promise<DocumentTaskReceipt> {
    return this.start(this.tasks.create(input, config), config);
  }
  async start(receipt: DocumentTaskReceipt, config: DocumentConfiguration): Promise<DocumentTaskReceipt> {
    let task: DocumentRecord;
    try { task = this.tasks.record(receipt.threadId); } catch (error) { if (error instanceof AppError && error.code === "TASK_CHECKPOINT_UNREADABLE") return receipt; throw error; }
    if (task.state !== "PENDING" || task.runId !== receipt.runId) return receipt;
    if ("secrets" in config || !task.checkpointId) await this.initialize(receipt.threadId);
    if (!("secrets" in config)) return receipt;
    if (this.tasks.record(receipt.threadId).state === "PENDING") void this.run(receipt.threadId, config, receipt.runId).catch(() => {}); return receipt;
  }
  async control(id: string, input: unknown, config: DocumentConfiguration): Promise<DocumentTaskReceipt> {
    id = id.toLowerCase();
    const action = text(input, "action"); if (["resume", "retry_failed"].includes(action)) invariant("secrets" in config, "MODEL_NOT_CONFIGURED", "Explicit model work requires its credential snapshot");
    const previous = this.tasks.controlReplay(id, input); let expectedVersion: number | undefined;
    if (!previous && !["pause", "interrupt"].includes(action)) { const record = this.tasks.record(id); await this.validateCheckpoint(record); expectedVersion = record.updatedAt; }
    const receipt = previous ?? this.tasks.control(id, input, config, expectedVersion);
    if (["pause", "interrupt"].includes(action)) {
      const work = this.running.get(id);
      if (work?.runId === receipt.runId) { if (action === "interrupt") work.controller.abort(); }
      else {
        let task: DocumentRecord;
        try { task = this.tasks.record(id); } catch (error) { if (previous && error instanceof AppError && error.code === "TASK_CHECKPOINT_UNREADABLE") return receipt; throw error; }
        if (task.runId === receipt.runId && task.desired === action) {
          if (!task.checkpointId && task.executionBuild === executionBuildFingerprint()) await this.initialize(id);
          this.tasks.stop(id, receipt.runId);
        }
      }
    }
    if (["resume", "retry_failed"].includes(action)) {
      let task: DocumentRecord;
      try { task = this.tasks.record(id); } catch (error) { if (previous && error instanceof AppError && error.code === "TASK_CHECKPOINT_UNREADABLE") return receipt; throw error; }
      if (task.state === "PENDING" && task.runId === receipt.runId) { invariant("secrets" in config, "MODEL_NOT_CONFIGURED", "Explicit model work requires its credential snapshot"); await this.initialize(id); void this.run(id, config, receipt.runId).catch(() => {}); }
    }
    return receipt;
  }
  run(id: string, config: AiSnapshot, runId?: string): Promise<void> {
    const task = this.tasks.record(id), previous = this.running.get(id);
    if (runId !== undefined && task.runId !== runId) return Promise.resolve();
    if (previous) return previous.runId === task.runId ? previous.done : previous.done.then(() => this.run(id, config, runId));
    if (task.state !== "PENDING" && !task.desired) return Promise.resolve();
    const authorization: Authorization = { runId: task.runId, config, controller: new AbortController(), pending: new Set() };
    const done = this.execute(id, authorization).finally(() => { if (this.running.get(id)?.runId === authorization.runId) this.running.delete(id); }); this.running.set(id, { runId: task.runId, controller: authorization.controller, done }); return done;
  }
  private async execute(id: string, authorization: Authorization): Promise<void> {
    const config = graphConfig(id);
    try {
      await this.initialize(id);
      if (this.tasks.record(id).desired) { this.tasks.stop(id, authorization.runId); return; }
      this.tasks.begin(id, authorization.runId, authorization.config);
      const execution = new DocumentExecution(this.store, this.tasks.record(id), authorization.config, authorization.controller, () => this.tasks.record(id));
      await execution.run(async () => {
        try { return await this.graph(authorization).invoke(null, { ...config, signal: authorization.controller.signal }); }
        // LangGraph may reject on abort before its active node finishes releasing workers.
        finally { await Promise.allSettled([...authorization.pending]); }
      });
      const saved = await this.checkpoints.getTuple(config); if (saved) this.tasks.checkpoint(id, authorization.runId, saved.checkpoint.id);
      if (this.tasks.record(id).desired) this.tasks.stop(id, authorization.runId); else this.tasks.finish(id, authorization.runId);
    } catch (error) {
      if (this.tasks.record(id).runId !== authorization.runId) return;
      const saved = await this.checkpoints.getTuple(config); if (saved) this.tasks.checkpoint(id, authorization.runId, saved.checkpoint.id);
      const reason = authorization.controller.signal.reason; this.tasks.stop(id, authorization.runId, safeCode(reason instanceof AppError ? reason : error), authorization.stage);
    }
  }
  async recover(): Promise<void> {
    invariant(this.running.size === 0, "TASK_BUSY", "Cannot recover while document work is active");
    for (const task of this.tasks.unfinished()) {
      if (task.executionBuild !== executionBuildFingerprint()) continue;
      try { await this.initialize(task.id); this.tasks.recover(task.id); }
      catch (error) { if (!unreadableEvidence(error)) throw error; this.tasks.stop(task.id, task.runId, "TASK_CHECKPOINT_UNREADABLE"); }
    }
  }
  delete(id: string): Promise<{ threadId: string; deleted: true }> {
    id = id.toLowerCase(); const previous = this.deleting.get(id); if (previous) return previous;
    invariant(!this.running.has(id) && !this.initializing.has(id), "TASK_BUSY", "Stop the task before deleting it");
    const done = this.deleteOnce(id).finally(() => this.deleting.delete(id)); this.deleting.set(id, done); return done;
  }
  private async deleteOnce(id: string): Promise<{ threadId: string; deleted: true }> {
    this.tasks.beginDelete(id); await this.checkpoints.deleteThread(`document:${id}`);
    for (;;) {
      const items = await this.store.search(["document_tasks", id], { limit: 100 }); if (!items.length) break;
      await this.store.batch(items.map(item => ({ namespace: item.namespace, key: item.key, value: null })));
    }
    this.tasks.finishDelete(id); return { threadId: id, deleted: true };
  }
  async settle(): Promise<void> { await Promise.allSettled([...Array.from(this.running.values(), value => value.done), ...this.initializing.values(), ...this.deleting.values()]); }
  wait(id: string): Promise<void> { return this.running.get(id)?.done ?? Promise.resolve(); }
  active(): number { return this.running.size; }
  busy(): boolean { return this.running.size + this.initializing.size + this.deleting.size > 0; }
  // Process shutdown may stop in-flight paid work; durable provider receipts prevent replay.
  abortAll(): void { for (const work of this.running.values()) work.controller.abort(); }
}
