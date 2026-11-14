import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
const runtimeBase = process.argv[3] ? pathToFileURL(`${realpathSync(process.argv[3])}/`) : new URL("../.build/electron/app/desktop/", import.meta.url);
const { PracticeStore } = await import(new URL("store.js", runtimeBase).href) as typeof import("../desktop/store.js");
const { Backups } = await import(new URL("backup.js", runtimeBase).href) as typeof import("../desktop/backup.js");
const { LegacySettings } = await import(new URL("legacy-settings.js", runtimeBase).href) as typeof import("../desktop/legacy-settings.js");
const { AiSettings } = await import(new URL("ai-settings.js", runtimeBase).href) as typeof import("../desktop/ai-settings.js");
const { BoundedZip } = await import(new URL("zip.js", runtimeBase).href) as typeof import("../desktop/zip.js");

assert.ok(process.argv[2], "Pass an existing profile containing v4/practiq.sqlite");
const profile = realpathSync(process.argv[2]), evidence = resolve(".build/evidence");
assert.ok(process.argv[2] && lstatSync(join(profile, "v4", "practiq.sqlite")).isFile(), "Pass an existing profile containing v4/practiq.sqlite");
mkdirSync(evidence, { recursive: true }); const output = mkdtempSync(join(evidence, "existing-data-")), copied = join(output, "copy"), restored = join(output, "restored");
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const json = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? { integer: item.toString() } : item instanceof Uint8Array ? { bytes: Buffer.from(item).toString("base64") } : item);
function inventory(root: string, prefix = ""): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of readdirSync(join(root, prefix)).sort()) {
    const path = join(root, prefix, name), stat = lstatSync(path), relative = join(prefix, name);
    assert.ok(!stat.isSymbolicLink(), "Profile contains a link; review it before copying");
    if (stat.isDirectory()) Object.assign(result, inventory(root, relative));
    else { assert.ok(stat.isFile() && stat.size <= 512 * 1024 * 1024, "Profile contains an unsupported file"); result[relative] = digest(readFileSync(path)); }
  }
  return result;
}
function tables(db: DatabaseSync) {
  return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name").all().map(row => {
    const name = String(row.name); assert.match(name, /^[a-z_]+$/);
    const statement = db.prepare(`SELECT * FROM "${name}"`); statement.setReturnArrays(true); statement.setReadBigInts(true);
    const values = statement.all().map(json).sort(); return [name, { count: values.length, sha256: digest(values.join("\n")) }];
  }));
}
function sessionValue(value: unknown) {
  const result = { ...(value as Record<string, unknown>) };
  // Worker epochs and the live clock are transport state, not immutable saved content.
  for (const field of ["snapshotKey", "attemptKey", "attemptsBase", "clockNow"]) delete result[field];
  return result;
}
const original = inventory(profile); cpSync(join(profile, "v4"), copied, { recursive: true, errorOnExist: true, force: false });
const beforeDb = new DatabaseSync(join(copied, "practiq.sqlite"), { readOnly: true }); let expected: ReturnType<typeof tables>;
try { assert.equal(beforeDb.prepare("PRAGMA user_version").get()!.user_version, 11); expected = tables(beforeDb); } finally { beforeDb.close(); }
const store = new PracticeStore(copied); let target: InstanceType<typeof PracticeStore> | undefined;
try {
  assert.equal(digest(json(tables(store.db))), digest(json(expected)), "Opening the copy changed practice rows");
  const bankIds = store.banks().map(bank => bank.id), questionIds = store.db.prepare("SELECT id FROM questions WHERE parent_id IS NULL ORDER BY id").all().map(row => String(row.id)), sessions = store.db.prepare("SELECT id FROM sessions ORDER BY id").all().map(row => String(row.id));
  for (const id of questionIds) store.request({ type: "question_detail", id });
  for (const id of sessions) store.request({ type: "session", id });
  store.request({ type: "questions_page", bank_ids: bankIds, search: "", mode: "", filter: "", limit: 100, offset: 0, include_stats: true });
  const today = new Date(); today.setHours(0, 0, 0, 0); store.request({ type: "learning_overview", days: 7, today_start: today.getTime(), since: today.getTime() - 6 * 86400000 });
  const legacy = new LegacySettings(copied).read(), learning = store.learning.backup();
  assert.equal(legacy.pending, null, "The copied profile requires restore recovery before acceptance");
  for (let i = 0; i < bankIds.length; i++) await store.request({ type: "_export_bank", bank_id: bankIds[i], path: join(output, `bank-${i}.zip`) });
  const backup = join(output, "practice-backup.zip"); await new Backups(store).export(backup);
  const archive = await BoundedZip.open(backup, { archiveBytes: 600 * 1024 * 1024, expandedBytes: 600 * 1024 * 1024, entries: 100000 }); let assetCount: number;
  try {
    assert.ok([...archive.entries.keys()].every(name => ["manifest.json", "practiq.sqlite"].includes(name) || /^assets\/[a-f0-9]{64}$/.test(name)), "Backup contains unrelated AI or credential files");
    assetCount = [...archive.entries.keys()].filter(name => name.startsWith("assets/")).length;
  } finally { archive.close(); }
  mkdirSync(restored); target = new PracticeStore(restored); await new Backups(target).restore(backup, false);
  assert.equal(digest(json(tables(target.db))), digest(json(expected)), "Restored practice rows differ from the existing database");
  assert.equal(digest(json(new LegacySettings(restored).read().active)), digest(json(legacy.active)), "Legacy settings were reinterpreted");
  assert.equal(digest(json(target.learning.backup())), digest(json(learning)), "Learning notes changed during restore");
  for (const id of questionIds) assert.equal(digest(json(target.request({ type: "question_detail", id }))), digest(json(store.request({ type: "question_detail", id }))), "Restored question projection differs");
  for (const id of sessions) assert.equal(digest(json(sessionValue(target.request({ type: "session", id })))), digest(json(sessionValue(store.request({ type: "session", id })))), "Restored immutable session differs");
  for (const row of store.db.prepare("SELECT hash,size FROM assets").all()) assert.equal(digest(target.assets.read(String(row.hash), Number(row.size))), digest(store.assets.read(String(row.hash), Number(row.size))), "Restored media differs");
  const unavailable = async (): Promise<never> => { throw Error("Legacy credential access is forbidden in this probe"); }, settings = new AiSettings(copied, { isAsyncEncryptionAvailable: unavailable, encryptStringAsync: unavailable, decryptStringAsync: unavailable });
  assert.ok(Object.values((await settings.view()).configured).every(value => value === false), "Legacy credentials must not become embedded provider settings");
  assert.equal(digest(json(tables(store.db))), digest(json(expected)), "Read/export changed the copied practice rows");
  const refusals: { version: number; refused: boolean }[] = [];
  for (const relative of ["practiq.sqlite", "v2/practiq.sqlite", "v3/practiq.sqlite"]) {
    const path = join(profile, relative); if (!original[relative]) continue;
    const folder = join(output, relative.replaceAll("/", "-")); mkdirSync(folder); cpSync(path, join(folder, "practiq.sqlite")); const files = inventory(folder); const db = new DatabaseSync(join(folder, "practiq.sqlite"), { readOnly: true }); const version = Number(db.prepare("PRAGMA user_version").get()!.user_version); db.close();
    let refused = false; try { const older = new PracticeStore(folder); older.close(); } catch (error) { refused = (error as { code?: string }).code === "LOCAL_BACKUP_DATABASE_VERSION"; }
    assert.ok(refused, "An unsupported historical database was accepted"); assert.equal(digest(json(inventory(folder))), digest(json(files)), "Refusal mutated a historical database copy"); refusals.push({ version, refused });
  }
  assert.equal(digest(json(inventory(profile))), digest(json(original)), "Original profile changed during the probe");
  const report = { checkedAt: new Date().toISOString(), schemaVersion: 11, runtimeNode: process.versions.node, runtimeImplementation: process.argv[3] ? "installed-package" : "workspace-build", tables: expected, bankCount: bankIds.length, rootQuestionCount: questionIds.length, sessionCount: sessions.length, assetCount, originalProfileUnchanged: true, allPracticeRowsPreserved: true, questionAndSessionProjectionsMatch: true, backupRestoreVerified: true, aiAndCredentialsExcludedFromBackup: true, legacyKeychain: "not accessed or migrated", historicalRefusals: refusals };
  writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ report: join(output, "report.json"), banks: bankIds.length, sessions: sessions.length, assets: assetCount, originalProfileUnchanged: true }));
} finally { target?.close(); store.close(); }
