import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { BaseStore, validateNamespace, type Item, type ListNamespacesOperation, type Operation, type OperationResults, type PutOperation, type SearchOperation } from "@langchain/langgraph-checkpoint";
import { transaction } from "./database.js";
import { parseJson } from "./document-contract.js";
import { invariant } from "./errors.js";
import { regularFileExists, syncDirectory } from "./filesystem.js";
import { canonical } from "./questions.js";

const VALUE_LIMIT = 32 * 1024 * 1024, RESULT_LIMIT = 64 * 1024 * 1024;
const schema = `CREATE TABLE store_items(namespace TEXT NOT NULL CHECK(json_valid(namespace)),key TEXT NOT NULL,value TEXT NOT NULL CHECK(json_valid(value)),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(namespace,key));
CREATE INDEX store_items_updated ON store_items(updated_at DESC,namespace,key);
PRAGMA user_version=1;`;
type Row = Record<string, SQLOutputValue>;
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export function executionJson(value: unknown): string {
  const seen = new Set<object>();
  function visit(value: unknown, depth: number): void {
    invariant(depth <= 128, "LOCAL_RESPONSE_INVALID", "Store value is nested too deeply");
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number") { invariant(Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)), "LOCAL_RESPONSE_INVALID", "Invalid store number"); return; }
    invariant(value !== null && typeof value === "object" && !seen.has(value) && (Array.isArray(value) || plain(value)), "LOCAL_RESPONSE_INVALID", "Store values must contain plain JSON data"); seen.add(value);
    try {
      invariant(Object.getOwnPropertySymbols(value).length === 0 && Object.values(Object.getOwnPropertyDescriptors(value)).every(property => Object.hasOwn(property, "value")), "LOCAL_RESPONSE_INVALID", "Store values cannot contain symbols or accessors");
      if (Array.isArray(value)) for (let index = 0; index < value.length; index++) { invariant(Object.hasOwn(value, index), "LOCAL_RESPONSE_INVALID", "Store arrays cannot contain holes"); visit(value[index], depth + 1); } else Object.values(value).forEach(item => visit(item, depth + 1));
    }
    finally { seen.delete(value); }
  }
  visit(value, 0); const result = canonical(value); invariant(Buffer.byteLength(result) <= VALUE_LIMIT, "LOCAL_FILE_TOO_LARGE", "Store value exceeds its size limit"); return result;
}
function namespace(value: unknown, empty = false): asserts value is string[] {
  invariant(Array.isArray(value) && value.length <= 32 && value.every(label => typeof label === "string" && Buffer.byteLength(label) <= 255) && Buffer.byteLength(JSON.stringify(value)) <= 8192, "LOCAL_FILTER_INVALID", "Invalid store namespace");
  validateNamespace(value, { allowEmpty: empty, allowReservedRoot: true });
}
function key(value: unknown): asserts value is string { invariant(typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 2048 && !value.includes("\0"), "LOCAL_FILTER_INVALID", "Invalid store key"); }
function page(limit: unknown, offset: unknown): void { invariant(Number.isSafeInteger(limit) && Number(limit) >= 0 && Number(limit) <= 10000 && Number.isSafeInteger(offset) && Number(offset) >= 0, "LOCAL_FILTER_INVALID", "Invalid store pagination"); }
function equal(left: unknown, right: unknown): boolean { return left === undefined || right === undefined ? left === right : canonical(left) === canonical(right); }
function matches(actual: unknown, expected: unknown): boolean {
  if (!plain(expected) || !Object.keys(expected).some(key => key.startsWith("$"))) return equal(actual, expected);
  return Object.entries(expected).every(([operator, value]) => {
    invariant(["$eq", "$ne", "$gt", "$gte", "$lt", "$lte", "$in", "$nin"].includes(operator), "LOCAL_FILTER_INVALID", "Unsupported store filter operator");
    if (operator === "$eq") return equal(actual, value); if (operator === "$ne") return !equal(actual, value);
    if (operator === "$in" || operator === "$nin") { invariant(Array.isArray(value), "LOCAL_FILTER_INVALID", "Membership filters require an array"); const included = value.some(item => equal(actual, item)); return operator === "$in" ? included : !included; }
    if (typeof actual !== "number" || typeof value !== "number") return false;
    return operator === "$gt" ? actual > value : operator === "$gte" ? actual >= value : operator === "$lt" ? actual < value : actual <= value;
  });
}

/** Persistent LangGraph.js key/value Store; reads cannot invoke embeddings or models. */
export class SqliteStore extends BaseStore {
  readonly db: DatabaseSync;
  private closed = false;
  constructor(directory: string) {
    super(); mkdirSync(directory, { recursive: true, mode: 0o700 }); const path = join(directory, "ai-store-v1.sqlite"), expected = new DatabaseSync(":memory:"); expected.exec(schema);
    const definitions = (db: DatabaseSync) => canonical(db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all());
    const validate = (db: DatabaseSync) => invariant(db.prepare("PRAGMA user_version").get()?.user_version === 1 && definitions(db) === definitions(expected), "LOCAL_BACKUP_SCHEMA_UNSUPPORTED", "Unsupported LangGraph.js Store database; existing data remains unchanged");
    try {
      if (regularFileExists(path)) { const candidate = new DatabaseSync(path, { readOnly: true }); try { candidate.exec("PRAGMA trusted_schema=OFF"); if (candidate.prepare("PRAGMA user_version").get()?.user_version !== 0 || candidate.prepare("SELECT COUNT(*) AS n FROM sqlite_master").get()?.n !== 0) validate(candidate); } finally { candidate.close(); } }
      this.db = new DatabaseSync(path);
      try { this.db.exec("PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000"); if (this.db.prepare("PRAGMA user_version").get()?.user_version === 0) { invariant(this.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master").get()?.n === 0, "LOCAL_BACKUP_SCHEMA_UNSUPPORTED", "Cannot initialize a nonempty Store"); transaction(this.db, () => this.db.exec(schema)); } validate(this.db); this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL"); syncDirectory(directory); }
      catch (error) { this.db.close(); throw error; }
    } finally { expected.close(); }
  }
  override start(): void { invariant(!this.closed, "EXECUTION_STORE_UNAVAILABLE", "Reopen the execution Store before use"); }
  override stop(): void { if (!this.closed) { this.db.close(); this.closed = true; } }
  private item(row: Row): Item {
    const value = parseJson(Buffer.from(String(row.value))), path = JSON.parse(String(row.namespace)), created = Number(row.created_at), updated = Number(row.updated_at); namespace(path);
    invariant(plain(value) && Number.isSafeInteger(created) && Number.isSafeInteger(updated) && created >= 0 && updated >= created && Number.isFinite(new Date(updated).getTime()), "LOCAL_RESPONSE_INVALID", "Invalid saved Store item");
    return { value, key: String(row.key), namespace: path, createdAt: new Date(created), updatedAt: new Date(updated) };
  }
  private getItem(path: string[], itemKey: string): Item | null { const row = this.db.prepare("SELECT * FROM store_items WHERE namespace=? AND key=?").get(canonical(path), itemKey); return row ? this.item(row) : null; }
  read(path: string[], itemKey: string): Item | null { this.start(); namespace(path, true); key(itemKey); return this.getItem(path, itemKey); }
  readNamespace(path: string[]): Item[] {
    this.start(); namespace(path); const result: Item[] = []; let bytes = 0;
    for (const row of this.db.prepare("SELECT * FROM store_items WHERE namespace=? ORDER BY key").iterate(canonical(path))) {
      bytes += Buffer.byteLength(String(row.value)) + Buffer.byteLength(String(row.key)) + 256;
      invariant(result.length < 10000 && bytes <= RESULT_LIMIT, "LOCAL_FILE_TOO_LARGE", "Saved namespace exceeds its read limit"); result.push(this.item(row));
    }
    return result;
  }
  private putItem(operation: PutOperation): void {
    namespace(operation.namespace, operation.value === null); key(operation.key);
    invariant(operation.index === undefined || operation.index === false, "STORE_INDEX_UNSUPPORTED", "This execution Store has no semantic index");
    const path = canonical(operation.namespace);
    if (operation.value === null) { this.db.prepare("DELETE FROM store_items WHERE namespace=? AND key=?").run(path, operation.key); return; }
    invariant(plain(operation.value), "LOCAL_RESPONSE_INVALID", "Store item must be an object"); const value = executionJson(operation.value), now = Date.now();
    this.db.prepare("INSERT INTO store_items VALUES(?,?,?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value,updated_at=MAX(store_items.updated_at+1,excluded.updated_at)").run(path, operation.key, value, now, now);
  }
  private searchItems(operation: SearchOperation): Item[] {
    namespace(operation.namespacePrefix, true); const limit = operation.limit ?? 10, offset = operation.offset ?? 0; page(limit, offset);
    invariant(operation.query === undefined || operation.query === "", "STORE_QUERY_UNSUPPORTED", "Semantic search is not enabled for execution records");
    if (operation.filter !== undefined) {
      invariant(plain(operation.filter) && Object.keys(operation.filter).length <= 100 && Buffer.byteLength(executionJson(operation.filter)) <= 65536, "LOCAL_FILTER_INVALID", "Invalid Store filter");
      for (const expected of Object.values(operation.filter)) if (plain(expected) && Object.keys(expected).some(key => key.startsWith("$"))) for (const [operator, value] of Object.entries(expected)) invariant(["$eq", "$ne", "$gt", "$gte", "$lt", "$lte", "$in", "$nin"].includes(operator) && (!["$in", "$nin"].includes(operator) || Array.isArray(value)), "LOCAL_FILTER_INVALID", "Invalid Store filter operator");
    }
    if (!limit) return [];
    const result: Item[] = []; let skipped = 0, bytes = 0;
    const rows = this.db.prepare("SELECT * FROM store_items WHERE NOT EXISTS(SELECT 1 FROM json_each(?) p WHERE json_extract(store_items.namespace,'$['||p.key||']') IS NOT p.value) ORDER BY updated_at DESC,namespace,key").iterate(canonical(operation.namespacePrefix));
    for (const row of rows) {
      const item = this.item(row);
      if (operation.filter && !Object.entries(operation.filter).every(([field, value]) => matches(Object.hasOwn(item.value, field) ? item.value[field] : undefined, value))) continue;
      if (skipped++ < offset) continue;
      bytes += Buffer.byteLength(String(row.value)) + Buffer.byteLength(String(row.namespace)) + Buffer.byteLength(String(row.key)) + 256; invariant(bytes <= RESULT_LIMIT, "LOCAL_FILE_TOO_LARGE", "Store search result exceeds its size limit"); result.push(item); if (result.length >= limit) break;
    }
    return result;
  }
  private namespaces(operation: ListNamespacesOperation): string[][] {
    page(operation.limit, operation.offset); invariant(operation.maxDepth === undefined || Number.isSafeInteger(operation.maxDepth) && operation.maxDepth >= 0 && operation.maxDepth <= 32, "LOCAL_FILTER_INVALID", "Invalid namespace depth");
    for (const condition of operation.matchConditions ?? []) { invariant(["prefix", "suffix"].includes(condition.matchType), "LOCAL_FILTER_INVALID", "Invalid namespace match"); namespace(condition.path, true); }
    const found = new Map<string, string[]>();
    for (const row of this.db.prepare("SELECT DISTINCT namespace FROM store_items").iterate()) {
      const path: string[] = JSON.parse(String(row.namespace)); namespace(path);
      if (!(operation.matchConditions ?? []).every(condition => condition.path.length <= path.length && condition.path.every((label, index) => label === "*" || label === path[condition.matchType === "prefix" ? index : path.length - condition.path.length + index]))) continue;
      const truncated = operation.maxDepth === undefined ? path : path.slice(0, operation.maxDepth); found.set(canonical(truncated), truncated);
    }
    return [...found.values()].sort((a, b) => { for (let index = 0; index < Math.min(a.length, b.length); index++) { const compared = Buffer.compare(Buffer.from(a[index]), Buffer.from(b[index])); if (compared) return compared; } return a.length - b.length; }).slice(operation.offset, operation.offset + operation.limit);
  }
  override async batch<Op extends Operation[]>(operations: Op): Promise<OperationResults<Op>> {
    this.start(); invariant(Array.isArray(operations) && operations.length <= 10000, "LOCAL_FILTER_INVALID", "Invalid Store batch");
    return transaction(this.db, () => {
      const puts: PutOperation[] = [], results: unknown[] = [];
      for (const operation of operations) {
        invariant(plain(operation), "LOCAL_FILTER_INVALID", "Invalid Store operation");
        if ("namespace" in operation && "key" in operation) {
          namespace(operation.namespace, "value" in operation ? operation.value === null : true); key(operation.key);
          if ("value" in operation) { invariant(Object.keys(operation).every(key => ["namespace", "key", "value", "index"].includes(key)), "LOCAL_FILTER_INVALID", "Invalid Store write fields"); puts.push(operation as PutOperation); results.push(undefined); }
          else { invariant(Object.keys(operation).every(key => ["namespace", "key"].includes(key)), "LOCAL_FILTER_INVALID", "Invalid Store read fields"); results.push(this.getItem(operation.namespace, operation.key)); }
        } else if ("namespacePrefix" in operation) { invariant(Object.keys(operation).every(key => ["namespacePrefix", "filter", "limit", "offset", "query"].includes(key)), "LOCAL_FILTER_INVALID", "Invalid Store search fields"); results.push(this.searchItems(operation as SearchOperation)); }
        else { invariant(Object.keys(operation).every(key => ["matchConditions", "maxDepth", "limit", "offset"].includes(key)), "LOCAL_FILTER_INVALID", "Invalid namespace-list fields"); results.push(this.namespaces(operation as ListNamespacesOperation)); }
      }
      // LangGraph batch reads observe the pre-write snapshot, including reads after a put in the same batch.
      for (const operation of puts) this.putItem(operation); return results as OperationResults<Op>;
    });
  }
  async update(path: string[], itemKey: string, change: (value: Record<string, unknown> | null) => Record<string, unknown> | null): Promise<void> {
    this.updateSync(path, itemKey, change);
  }
  updateSync(path: string[], itemKey: string, change: (value: Record<string, unknown> | null) => Record<string, unknown> | null): void {
    this.start(); namespace(path); key(itemKey);
    transaction(this.db, () => this.putItem({ namespace: path, key: itemKey, value: change(this.getItem(path, itemKey)?.value ?? null), index: false }));
  }
  updateManySync(path: string[], itemKeys: string[], change: (values: (Record<string, unknown> | null)[]) => (Record<string, unknown> | null)[] | null): void {
    this.start(); namespace(path); invariant(itemKeys.length > 0 && itemKeys.length <= 100 && new Set(itemKeys).size === itemKeys.length, "LOCAL_FILTER_INVALID", "Invalid atomic Store update"); itemKeys.forEach(key);
    transaction(this.db, () => {
      const values = change(itemKeys.map(itemKey => this.getItem(path, itemKey)?.value ?? null)); if (values === null) return;
      invariant(Array.isArray(values) && values.length === itemKeys.length, "LOCAL_RESPONSE_INVALID", "Atomic Store update changed its key count");
      values.forEach((value, index) => this.putItem({ namespace: path, key: itemKeys[index], value, index: false }));
    });
  }
}
