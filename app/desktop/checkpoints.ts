import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BaseCheckpointSaver, compareWritesSortKeys, WRITES_IDX_MAP, writesSortKey, type Checkpoint, type CheckpointListOptions, type CheckpointMetadata, type CheckpointTuple, type PendingWrite, type SerializerProtocol } from "@langchain/langgraph-checkpoint";
import { invariant } from "./errors.js";
import { regularFileExists, syncDirectory } from "./filesystem.js";
import { transaction } from "./database.js";
import { canonical } from "./questions.js";

type Config = Parameters<BaseCheckpointSaver["get"]>[0];
const LIMIT = 64 * 1024 * 1024;
const schema = `CREATE TABLE checkpoints(thread_id TEXT NOT NULL,namespace TEXT NOT NULL,id TEXT NOT NULL,parent_id TEXT,checkpoint BLOB NOT NULL,metadata BLOB NOT NULL,PRIMARY KEY(thread_id,namespace,id));
CREATE TABLE checkpoint_writes(thread_id TEXT NOT NULL,namespace TEXT NOT NULL,checkpoint_id TEXT NOT NULL,task_id TEXT NOT NULL,idx INTEGER NOT NULL,channel TEXT NOT NULL,value BLOB NOT NULL,task_path TEXT NOT NULL,PRIMARY KEY(thread_id,namespace,checkpoint_id,task_id,idx));
PRAGMA user_version=1;`;

// Tag every value so document JSON cannot impersonate a serializer constructor.
export class CheckpointJson implements SerializerProtocol {
  async dumpsTyped(data: unknown): Promise<[string, Uint8Array]> {
    const seen = new Set<object>();
    function encode(value: unknown): unknown {
      if (value === undefined) return ["undefined"];
      if (value === null || typeof value === "string" || typeof value === "boolean") return ["value", value];
      if (typeof value === "number") { invariant(Number.isFinite(value), "LOCAL_RESPONSE_INVALID", "Nonfinite checkpoint number"); return ["value", value]; }
      invariant(value !== null && typeof value === "object" && !seen.has(value), "LOCAL_RESPONSE_INVALID", "Unsupported or cyclic checkpoint value");
      seen.add(value);
      try {
        if (value instanceof Error) return ["error", value.name, value.message];
        if (Array.isArray(value)) return ["array", value.map(encode)];
        invariant(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, "LOCAL_RESPONSE_INVALID", "Checkpoint state must use plain JSON objects");
        return ["object", Object.entries(value).map(([key, item]) => [key, encode(item)])];
      } finally { seen.delete(value); }
    }
    const bytes = Buffer.from(JSON.stringify(encode(data))); invariant(bytes.length <= LIMIT, "LOCAL_FILE_TOO_LARGE", "Checkpoint exceeds its size limit"); return ["practiq-json-v1", bytes];
  }
  async loadsTyped(type: string, data: Uint8Array | string): Promise<unknown> {
    invariant(type === "practiq-json-v1" && Buffer.byteLength(data) <= LIMIT, "LOCAL_RESPONSE_INVALID", "Unsupported checkpoint serialization");
    function decode(value: unknown): unknown {
      invariant(Array.isArray(value) && typeof value[0] === "string", "LOCAL_RESPONSE_INVALID", "Invalid checkpoint value");
      if (value[0] === "undefined" && value.length === 1) return undefined;
      if (value[0] === "value" && value.length === 2 && (value[1] === null || ["string", "boolean"].includes(typeof value[1]) || typeof value[1] === "number" && Number.isFinite(value[1]))) return value[1];
      if (value[0] === "error" && value.length === 3 && typeof value[1] === "string" && typeof value[2] === "string") { const error = new Error(value[2]); error.name = value[1]; return error; }
      if (value[0] === "array" && value.length === 2 && Array.isArray(value[1])) return value[1].map(decode);
      if (value[0] === "object" && value.length === 2 && Array.isArray(value[1])) {
        const keys = new Set<string>();
        return Object.fromEntries(value[1].map((pair: unknown) => {
          invariant(Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "string" && !keys.has(pair[0]), "LOCAL_RESPONSE_INVALID", "Invalid checkpoint object"); keys.add(pair[0]); return [pair[0], decode(pair[1])];
        }));
      }
      invariant(false, "LOCAL_RESPONSE_INVALID", "Invalid checkpoint serialization tag");
    }
    return decode(JSON.parse(typeof data === "string" ? data : new TextDecoder("utf-8", { fatal: true }).decode(data)));
  }
}
function identity(value: unknown, empty = false): string {
  invariant(typeof value === "string" && (empty || value.length > 0) && Buffer.byteLength(value) <= 2048, "LOCAL_FILTER_INVALID", "Invalid checkpoint identity"); return value;
}
function keys(config: Config): [string, string] { return [identity(config.configurable?.thread_id), identity(config.configurable?.checkpoint_ns ?? "", true)]; }

export class SqliteCheckpoints extends BaseCheckpointSaver {
  readonly db: DatabaseSync;
  constructor(directory: string) {
    super(new CheckpointJson()); mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, "ai-checkpoints-v1.sqlite"), expected = new DatabaseSync(":memory:"); expected.exec(schema);
    const definitions = (db: DatabaseSync) => JSON.stringify(db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all());
    const validate = (db: DatabaseSync) => invariant(db.prepare("PRAGMA user_version").get()?.user_version === 1 && definitions(db) === definitions(expected), "LOCAL_BACKUP_SCHEMA_UNSUPPORTED", "Unsupported checkpoint database; existing data remains unchanged");
    try {
      if (regularFileExists(path)) {
        const candidate = new DatabaseSync(path, { readOnly: true });
        try { candidate.exec("PRAGMA trusted_schema=OFF"); if (candidate.prepare("PRAGMA user_version").get()?.user_version !== 0 || candidate.prepare("SELECT count(*) AS count FROM sqlite_master").get()?.count !== 0) validate(candidate); }
        finally { candidate.close(); }
      }
      this.db = new DatabaseSync(path);
      try {
        this.db.exec("PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000");
        if (this.db.prepare("PRAGMA user_version").get()?.user_version === 0) { invariant(this.db.prepare("SELECT count(*) AS count FROM sqlite_master").get()?.count === 0, "LOCAL_BACKUP_SCHEMA_UNSUPPORTED", "Cannot initialize a nonempty checkpoint database"); transaction(this.db, () => this.db.exec(schema)); }
        validate(this.db); this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL"); syncDirectory(directory);
      } catch (error) { this.db.close(); throw error; }
    } finally { expected.close(); }
  }
  close(): void { this.db.close(); }
  private async decode(value: unknown): Promise<unknown> { invariant(value instanceof Uint8Array, "LOCAL_RESPONSE_INVALID", "Invalid checkpoint storage class"); return this.serde.loadsTyped("practiq-json-v1", value); }
  async getTuple(config: Config): Promise<CheckpointTuple | undefined> {
    const [thread, namespace] = keys(config), id = config.configurable?.checkpoint_id;
    if (id !== undefined) identity(id);
    const row = id === undefined ? this.db.prepare("SELECT * FROM checkpoints WHERE thread_id=? AND namespace=? ORDER BY id DESC LIMIT 1").get(thread, namespace) : this.db.prepare("SELECT * FROM checkpoints WHERE thread_id=? AND namespace=? AND id=?").get(thread, namespace, String(id));
    if (!row) return undefined;
    const writes = this.db.prepare("SELECT task_id,idx,channel,value,task_path FROM checkpoint_writes WHERE thread_id=? AND namespace=? AND checkpoint_id=?").all(thread, namespace, row.id);
    writes.sort((a, b) => compareWritesSortKeys(writesSortKey(String(a.task_path), String(a.task_id), Number(a.idx)), writesSortKey(String(b.task_path), String(b.task_id), Number(b.idx))));
    return { config: { configurable: { thread_id: thread, checkpoint_ns: namespace, checkpoint_id: row.id } }, checkpoint: await this.decode(row.checkpoint) as Checkpoint, metadata: await this.decode(row.metadata) as CheckpointMetadata,
      ...(row.parent_id === null ? {} : { parentConfig: { configurable: { thread_id: thread, checkpoint_ns: namespace, checkpoint_id: row.parent_id } } }),
      pendingWrites: await Promise.all(writes.map(async write => [String(write.task_id), String(write.channel), await this.decode(write.value)] as [string, string, unknown])) };
  }
  async *list(config: Config, options: CheckpointListOptions = {}): AsyncGenerator<CheckpointTuple> {
    const thread = config.configurable?.thread_id, namespace = config.configurable?.checkpoint_ns, before = options.before?.configurable?.checkpoint_id;
    if (thread !== undefined) identity(thread); if (namespace !== undefined) identity(namespace, true); if (before !== undefined) identity(before);
    invariant(options.limit === undefined || Number.isSafeInteger(options.limit) && options.limit >= 0, "LOCAL_FILTER_INVALID", "Invalid checkpoint history limit");
    let count = 0;
    const rows = this.db.prepare("SELECT thread_id,namespace,id FROM checkpoints WHERE (? IS NULL OR thread_id=?) AND (? IS NULL OR namespace=?) AND (? IS NULL OR id<?) ORDER BY id DESC").all(thread ?? null, thread ?? null, namespace ?? null, namespace ?? null, before ?? null, before ?? null);
    for (const row of rows) {
      if (options.limit !== undefined && count >= options.limit) return;
      const tuple = await this.getTuple({ configurable: { thread_id: row.thread_id, checkpoint_ns: row.namespace, checkpoint_id: row.id } }); if (!tuple) continue;
      if (options.filter && !Object.entries(options.filter).every(([key, value]) => Object.hasOwn(tuple.metadata ?? {}, key) && canonical((tuple.metadata as Record<string, unknown>)[key]) === canonical(value))) continue;
      count++; yield tuple;
    }
  }
  async put(config: Config, checkpoint: Checkpoint, metadata: CheckpointMetadata): Promise<Config> {
    const [thread, namespace] = keys(config), id = identity(checkpoint.id), parent = config.configurable?.checkpoint_id;
    if (parent !== undefined) identity(parent);
    const [, checkpointBytes] = await this.serde.dumpsTyped(checkpoint), [, metadataBytes] = await this.serde.dumpsTyped(metadata);
    this.db.prepare("INSERT OR REPLACE INTO checkpoints VALUES(?,?,?,?,?,?)").run(thread, namespace, id, parent ?? null, checkpointBytes, metadataBytes);
    return { configurable: { thread_id: thread, checkpoint_ns: namespace, checkpoint_id: id } };
  }
  async putWrites(config: Config, writes: PendingWrite[], taskId: string, taskPath = ""): Promise<void> {
    const [thread, namespace] = keys(config), id = identity(config.configurable?.checkpoint_id); identity(taskId); identity(taskPath, true);
    const values = await Promise.all(writes.map(async ([channel, value], index) => { identity(channel); const [, bytes] = await this.serde.dumpsTyped(value); return { channel, bytes, index: Object.hasOwn(WRITES_IDX_MAP, channel) ? WRITES_IDX_MAP[channel] : index }; }));
    transaction(this.db, () => {
      for (const value of values) this.db.prepare(`INSERT ${value.index < 0 ? "OR REPLACE" : "OR IGNORE"} INTO checkpoint_writes VALUES(?,?,?,?,?,?,?,?)`).run(thread, namespace, id, taskId, value.index, value.channel, value.bytes, taskPath);
    });
  }
  async deleteThread(threadId: string): Promise<void> {
    identity(threadId); transaction(this.db, () => { this.db.prepare("DELETE FROM checkpoint_writes WHERE thread_id=?").run(threadId); this.db.prepare("DELETE FROM checkpoints WHERE thread_id=?").run(threadId); });
  }
}
