import { afterEach, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PracticeStore } from "./store.js";
import { Backups } from "./backup.js";
import { hash } from "./assets.js";
import { BoundedZip, writeZip } from "./zip.js";
import { previewPaper } from "./paper.js";
import { readQuestions } from "./questions.js";
import { LegacySettings } from "./legacy-settings.js";
import * as filesystem from "./filesystem.js";
import { BACKUP_ARCHIVE_LIMIT, BACKUP_LIMIT } from "./backup-validation.js";
import { validateLearningData } from "./learning.js";

const directories: string[] = [], stores = new Set<PracticeStore>();
function directory() { const value = mkdtempSync(join(tmpdir(), "practiq-backup-")); directories.push(value); return value; }
function store(path = join(directory(), "data")) { const value = new PracticeStore(path); stores.add(value); return value; }
function close(value: PracticeStore) { value.close(); stores.delete(value); }
function populated(title: string) {
  const value = store(), bytes = readFileSync(new URL("../fixtures/rich-content/resources/chart.png", import.meta.url)), digest = hash(bytes), ref = { objectKey: "chart.png", sha256: digest, mediaType: "image/png", sizeBytes: bytes.length };
  const p = value.packages.preview({ schemaVersion: 3, questions: [{ id: "one", stem: "Source question", answerMode: "true_false", answerPayload: { value: true } }], groups: [], visualElements: [{ kind: "image", description: "Image", imageRef: ref, questionIds: ["one"] }], warnings: [], confidenceScore: 0 }, title) as { ticket: string };
  const bank = value.packages.import(p.ticket, null, title); value.assets.write(digest, bytes);
  value.db.prepare("INSERT INTO assets VALUES(?,?,?,?)").run(digest, "image/png", bytes.length, `assets/${digest}`);
  const question = readQuestions(value.db, value.assets, [bank.bankId])[0].id;
  const paper = previewPaper(value.db, value.assets, { bank_ids: [bank.bankId], search: "", mode: "", filter: "", selection: "manual", count: 0, quotas: {}, question_ids: [question], random: false, total_cents: 0 });
  const session = value.sessions.createPaper({ question_ids: paper.questionIds, kind: "practice", minutes: null, scores: [], total_cents: 0, digest: paper.digest });
  value.sessions.writeAttempt(session.id, 0, { value: true }, 10, true, false);
  value.learning.saveNote(question, "Retain my note", "misread"); value.favorite(question, true); value.reviewQuestion(question, true); value.saveLanguage("zh-TW");
  return { value, bank: bank.bankId, question, session: session.id, digest, bytes };
}
afterEach(() => { vi.restoreAllMocks(); for (const value of stores) value.close(); stores.clear(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
async function archive(path: string): Promise<Map<string, Buffer>> {
  const zip = await BoundedZip.open(path, { archiveBytes: BACKUP_ARCHIVE_LIMIT, expandedBytes: BACKUP_ARCHIVE_LIMIT, entries: 100000 }), entries = new Map<string, Buffer>();
  try { for (const name of zip.entries.keys()) entries.set(name, await zip.read(name, BACKUP_LIMIT)); } finally { zip.close(); }
  return entries;
}
async function modifiedBackup(path: string, modify: (manifest: Record<string, unknown>, files: Map<string, Buffer>) => void): Promise<string> {
  const files = await archive(path), manifest = JSON.parse(files.get("manifest.json")!.toString()); modify(manifest, files); files.set("manifest.json", Buffer.from(JSON.stringify(manifest)));
  const result = join(directory(), "modified.zip"); await writeZip(result, [...files].map(([name, data]) => ({ name, data })), BACKUP_ARCHIVE_LIMIT); return result;
}
function changeDatabase(manifest: Record<string, unknown>, files: Map<string, Buffer>, change: (db: DatabaseSync) => void) {
  const path = join(directory(), "candidate.sqlite"); writeFileSync(path, files.get("practiq.sqlite")!);
  const db = new DatabaseSync(path); try { db.exec("PRAGMA trusted_schema=OFF"); change(db); } finally { db.close(); }
  const bytes = readFileSync(path); files.set("practiq.sqlite", bytes); manifest.database = { file: "practiq.sqlite", sha256: hash(bytes), sizeBytes: bytes.length };
}

it("round-trips version-4 backups, frozen history, review state, notes and legacy settings while excluding AI state", async () => {
  const source = populated("Incoming"), target = populated("Previous"), output = join(directory(), "backup.zip"), settings = new LegacySettings(source.value.directory);
  settings.prepare({ service_url: "http://127.0.0.1:8090", model: { base_url: "https://archive.invalid/v1", model_id: "historical" } }, filesystem.fileDigest(join(source.value.directory, "practiq.sqlite"), BACKUP_LIMIT).sha256); settings.finish(true, source.value.db);
  writeFileSync(join(source.value.directory, "ai.sqlite"), "EXCLUDED_AI_STATE"); writeFileSync(join(source.value.directory, "import-service-v1.json"), "EXCLUDED_LOCAL_ORIGIN");
  source.value.db.prepare("INSERT INTO grade_requests VALUES('pending',?,0,'{}',NULL,0)").run(source.session);
  source.value.db.prepare("INSERT INTO grade_requests VALUES('historical',?,0,'{}',?,0)").run(source.session, JSON.stringify({ error: { code: "LEGACY_PROVIDER_ERROR" } }));
  await source.value.request({ type: "_backup", path: output });
  expect(source.value.learning.status().lastBackupAt).toBeTypeOf("number"); expect(source.value.db.prepare("SELECT id FROM grade_requests WHERE id='pending'").get()).toBeDefined();
  const files = await archive(output); expect([...files.keys()].sort()).toEqual(["manifest.json", "practiq.sqlite", `assets/${source.digest}`].sort());
  const result = await new Backups(target.value).restore(output, false); expect(existsSync(result.recoveryPath)).toBe(true);
  expect(target.value.banks()).toMatchObject([{ title: "Incoming" }]); expect(target.value.language()).toBe("zh-TW");
  expect(target.value.learning.note(source.question)).toMatchObject({ body: "Retain my note", cause: "misread" }); expect(target.value.learning.data().lastBackupAt).toBeNull();
  expect(target.value.sessions.session(source.session).attempts[0]).toMatchObject({ answer: { value: true }, result: true });
  expect(target.value.questionDetail(source.question)).toMatchObject({ favorite: true, reviewedAt: expect.any(Number) }); expect(target.value.assets.read(source.digest, source.bytes.length)).toEqual(source.bytes);
  expect(target.value.db.prepare("SELECT id FROM grade_requests ORDER BY id").all().map(row => row.id)).toEqual(["historical"]);
  expect(new LegacySettings(target.value.directory).read().active).toEqual(settings.read().active);
  const oldKey = target.value.sessions.session(source.session).snapshotKey;
  await new Backups(target.value).restore(output, false);
  const restoredKey = target.value.sessions.session(source.session).snapshotKey; expect(restoredKey).not.toBe(oldKey);
  expect(target.value.sessions.session(source.session, oldKey).attempts[0].snapshot).toBeDefined();
  await new Backups(target.value).restore(result.recoveryPath, false); expect(target.value.banks()).toMatchObject([{ title: "Previous" }]);
});

it("refuses live-file aliases but atomically replaces a user-selected external backup", async () => {
  const { value } = populated("Safe"), alias = join(directory(), "data-alias"); symlinkSync(value.directory, alias);
  const db = readFileSync(join(value.directory, "practiq.sqlite"));
  await expect(new Backups(value).export(join(alias, "practiq.sqlite"))).rejects.toMatchObject({ code: "LOCAL_BACKUP_OVERWRITE" }); expect(readFileSync(join(value.directory, "practiq.sqlite"))).toEqual(db);
  const output = join(directory(), "backup.zip"); writeFileSync(output, "old backup"); await new Backups(value).export(output); expect((await archive(output)).has("manifest.json")).toBe(true);
});

it.each(["hash", "extra", "duplicate", "settings", "note", "note-cause", "legacy", "resource"])("rejects %s backup corruption before mutating current state", async kind => {
  const source = populated("Incoming"), target = populated("Previous"), output = join(directory(), "backup.zip"); await new Backups(source.value).export(output);
  const modified = await modifiedBackup(output, (manifest, files) => {
    if (kind === "hash") (manifest.database as Record<string, unknown>).sha256 = "a".repeat(64);
    if (kind === "extra") files.set("unexpected", Buffer.from("keep out"));
    if (kind === "duplicate") (manifest.assets as unknown[]).push((manifest.assets as unknown[])[0]);
    if (kind === "settings") manifest.serviceSettings = { version: 1, config: { executable: "/bin/sh" } };
    if (kind === "note") (manifest.learningData as { notes: Record<string, unknown> }).notes.missing = { body: "unknown", cause: null, updatedAt: 0 };
    if (kind === "note-cause") (manifest.learningData as { notes: Record<string, { cause: unknown }> }).notes[source.question].cause = ["misread"];
    if (kind === "legacy") manifest.schemaVersion = 10;
    if (kind === "resource") files.set(`assets/${source.digest}`, Buffer.from("damaged"));
  });
  const before = readFileSync(join(target.value.directory, "practiq.sqlite")), notes = target.value.learning.data();
  await expect(new Backups(target.value).restore(modified, false)).rejects.toThrow();
  expect(readFileSync(join(target.value.directory, "practiq.sqlite"))).toEqual(before); expect(target.value.learning.data()).toEqual(notes); expect(existsSync(join(target.value.directory, "recoveries"))).toBe(false);
});

it("normalizes absent optional version-1 learning fields without accepting coerced mistake causes", () => {
  expect(validateLearningData({ version: 1, notes: { question: { body: "Historical note", updatedAt: 0 } } })).toEqual({ version: 1, notes: { question: { body: "Historical note", cause: null, updatedAt: 0 } }, lastBackupAt: null });
});

it("explicit repair retains damaged and unindexed original bytes and repairs snapshot-only resources", async () => {
  const source = populated("Incoming"), target = populated("Previous"), output = join(directory(), "backup.zip"); await new Backups(source.value).export(output);
  target.value.deleteBank(target.bank); writeFileSync(target.value.assets.path(target.digest), "damaged-original");
  await expect(new Backups(target.value).restore(output, false)).rejects.toThrow();
  const result = await new Backups(target.value).restore(output, true), inventory = JSON.parse(readFileSync(join(result.recoveryPath, "inventory.json"), "utf8"));
  expect(inventory.assets).toContainEqual(expect.objectContaining({ sha256: target.digest, status: "damaged" }));
  expect(readFileSync(join(result.recoveryPath, `assets/${target.digest}`), "utf8")).toBe("damaged-original");
  expect(target.value.assets.read(source.digest, source.bytes.length)).toEqual(source.bytes); expect(target.value.banks()[0].title).toBe("Incoming");
});

it("rolls back a failed publication and blocks the current instance when rollback cannot be synced", async () => {
  const source = populated("Incoming"), output = join(directory(), "backup.zip"); await new Backups(source.value).export(output);
  for (const failRollback of [false, true]) {
    const target = populated("Previous"), sync = filesystem.syncDirectory; let publicationFailed = false;
    vi.spyOn(filesystem, "syncDirectory").mockImplementation(path => {
      if (path === target.value.directory) {
        const db = new DatabaseSync(join(path, "practiq.sqlite"), { readOnly: true }); let incoming: boolean;
        try { incoming = db.prepare("SELECT title FROM banks LIMIT 1").get()?.title === "Incoming"; } finally { db.close(); }
        if (incoming || failRollback && publicationFailed) { publicationFailed = true; throw new Error("injected fsync failure"); }
      }
      sync(path);
    });
    await expect(new Backups(target.value).restore(output, false)).rejects.toThrow(); vi.restoreAllMocks();
    expect(publicationFailed).toBe(true);
    if (failRollback) {
      expect(() => target.value.request({ type: "banks" })).toThrow("recovery"); expect(new LegacySettings(target.value.directory).read().pending).not.toBeNull();
      close(target.value); const restarted = store(target.value.directory); expect(restarted.banks()[0].title).toBe("Previous"); expect(new LegacySettings(restarted.directory).read().pending).toBeNull();
    } else { expect(target.value.banks()[0].title).toBe("Previous"); expect(new LegacySettings(target.value.directory).read().pending).toBeNull(); }
    expect(readdirSync(join(target.value.directory, "recoveries")).length).toBeGreaterThan(0);
  }
});

it.each(["schema", "detail", "attempt", "snapshot", "identity", "storage", "context", "unlinked", "cross-bank", "cross-import"])("rejects %s database corruption despite matching archive checksums", async kind => {
  const source = populated("Incoming"), target = populated("Previous"), output = join(directory(), "backup.zip"); await new Backups(source.value).export(output);
  const modified = await modifiedBackup(output, (manifest, files) => changeDatabase(manifest, files, db => {
    if (kind === "schema") db.exec("CREATE TABLE unknown(value)");
    if (kind === "detail") db.exec("DELETE FROM true_false_questions");
    if (kind === "attempt") db.exec("UPDATE attempts SET snapshot_question_id='missing'");
    if (kind === "snapshot") db.exec("UPDATE session_documents SET content=json_set(content,'$.groups',NULL)");
    if (kind === "identity") db.exec("UPDATE session_documents SET content=json_set(content,'$.questions[0].id','mismatch')");
    if (kind === "storage") db.exec("UPDATE banks SET title=x'1234'");
    if (kind === "context") db.exec("UPDATE visuals SET content=json_set(content,'$.imageRef.sizeBytes',-1)");
    if (kind === "unlinked") db.exec("INSERT INTO sections VALUES('unlinked',(SELECT id FROM banks LIMIT 1),x'1234',NULL)");
    if (kind === "cross-bank") {
      db.exec("INSERT INTO banks VALUES('other','Other','',0); INSERT INTO sections VALUES('wrong','other','Other',NULL)");
      db.prepare("INSERT INTO section_questions VALUES('wrong',?)").run(source.question);
    }
    if (kind === "cross-import") db.exec("INSERT INTO banks VALUES('other','Other','',0); INSERT INTO imports VALUES('other-import','other','digest',0); UPDATE questions SET import_id='other-import'");
  }));
  await expect(new Backups(target.value).restore(modified, false)).rejects.toThrow(); expect(target.value.banks()[0].title).toBe("Previous");
});

it("accepts historical locale schemas and archives without optional learning or settings metadata", async () => {
  const source = populated("Incoming"), target = populated("Previous"), output = join(directory(), "backup.zip"); await new Backups(source.value).export(output);
  const modified = await modifiedBackup(output, (manifest, files) => {
    delete manifest.serviceSettings; delete manifest.learningData;
    changeDatabase(manifest, files, db => db.exec("ALTER TABLE settings RENAME TO old_settings; CREATE TABLE settings(id INTEGER PRIMARY KEY CHECK(id=1),base_url TEXT,model_id TEXT,locale TEXT CHECK(locale IS NULL OR locale IN('zh-CN','en'))); INSERT INTO settings SELECT id,base_url,model_id,'en' FROM old_settings; DROP TABLE old_settings"));
  });
  await new Backups(target.value).restore(modified, false); expect(target.value.language()).toBe("en"); expect(target.value.learning.data().notes).toEqual({});
  expect(target.value.db.prepare("SELECT sql FROM sqlite_master WHERE name='settings'").get()!.sql).toContain("zh-TW");
});

it.each(["before", "after"])("recovers a real process killed %s database publication", async checkpoint => {
  const source = populated("Incoming"), target = populated("Previous"), output = join(directory(), "backup.zip"), targetDirectory = target.value.directory;
  await new Backups(source.value).export(output); close(target.value);
  const script = `
    import { mock } from 'node:test';
    import { DatabaseSync } from 'node:sqlite';
    import { existsSync,writeSync } from 'node:fs';
    import { join } from 'node:path';
    const [directory,source,checkpoint,moduleRoot]=process.argv.slice(1);
    const filesystem=new URL('filesystem.js',moduleRoot).href, actual=await import(filesystem);
    mock.module(filesystem,{namedExports:{...actual,syncDirectory(path){
      if(path===directory && existsSync(join(directory,'service-settings-v1.sqlite'))){
        const settings=new DatabaseSync(join(directory,'service-settings-v1.sqlite'),{readOnly:true});
        let pending;try{pending=settings.prepare('SELECT pending FROM service_settings').get()?.pending;}finally{settings.close();}
        const db=new DatabaseSync(join(directory,'practiq.sqlite'),{readOnly:true});
        let incoming;try{incoming=db.prepare('SELECT title FROM banks LIMIT 1').get()?.title==='Incoming';}finally{db.close();}
        if(pending && (checkpoint==='after'?incoming:!incoming)){writeSync(1,'CHECKPOINT\\n');process.kill(process.pid,'SIGSTOP');}
      }
      actual.syncDirectory(path);
    }}});
    const {PracticeStore}=await import(new URL('store.js',moduleRoot));
    const {Backups}=await import(new URL('backup.js',moduleRoot));
    const store=new PracticeStore(directory);await new Backups(store).restore(source,false);
    throw new Error('Restore checkpoint was not reached');
  `;
  const child = spawn(process.execPath, ["--experimental-test-module-mocks", "--input-type=module", "-e", script, targetDirectory, output, checkpoint, new URL("../.build/electron/app/desktop/", import.meta.url).href], { stdio: ["ignore", "pipe", "pipe"] });
  let errors = ""; child.stderr.on("data", data => { errors += String(data); });
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Restore child timed out: ${errors}`)), 15000);
      const finished = () => { clearTimeout(timer); reject(new Error(`Restore child exited before checkpoint: ${errors}`)); };
      child.once("exit", finished);
      child.stdout.on("data", data => { if (String(data).includes("CHECKPOINT")) { clearTimeout(timer); child.off("exit", finished); resolve(); } });
      child.once("error", error => { clearTimeout(timer); reject(error); });
    });
    child.kill("SIGKILL"); await exited;
    expect(new LegacySettings(targetDirectory).read().pending).not.toBeNull();
    const restarted = store(targetDirectory); expect(restarted.banks()[0].title).toBe(checkpoint === "after" ? "Incoming" : "Previous");
    expect(restarted.learning.note(checkpoint === "after" ? source.question : target.question)?.body).toBe("Retain my note");
    expect(new LegacySettings(targetDirectory).read().pending).toBeNull(); expect(restarted.request({ type: "save_bank", id: null, title: "After restart", description: "" })).toBeTypeOf("string");
  } finally { child.kill("SIGKILL"); await exited; }
}, 20000);
