import { afterEach, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Assets, hash, readBounded } from "./assets.js";
import { openPracticeDatabase } from "./database.js";

const directories: string[] = [];
function directory() { const path = mkdtempSync(join(tmpdir(), "practiq-assets-")); directories.push(path); return path; }
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
it("writes durable immutable files before publishing database references and verifies every read", () => {
  const path = directory(), db = openPracticeDatabase(path), assets = new Assets(path, db), bytes = Buffer.from("immutable resource"), digest = hash(bytes);
  try {
    assets.write(digest, bytes);
    expect(db.prepare("SELECT count(*) AS count FROM assets").get()?.count).toBe(0);
    db.prepare("INSERT INTO assets VALUES(?,?,?,?)").run(digest, "image/png", bytes.length, `assets/${digest}`);
    expect(assets.bytes(digest)?.bytes).toEqual(bytes);
    assets.write(digest, bytes);
    writeFileSync(assets.path(digest), "corruption");
    expect(() => assets.write(digest, bytes)).toThrow("checksum mismatch");
    const rows = [{ question: {}, visuals: [{ imageRef: { sha256: digest } }] }];
    assets.markMissing(rows);
    expect(rows[0]).toHaveProperty("missingAssets", true);
    expect(readFileSync(assets.path(digest), "utf8")).toBe("corruption");
  } finally { db.close(); }
});
it("rejects traversal, symbolic-link resources, symbolic-link directories and oversized reads", () => {
  const path = directory(), db = openPracticeDatabase(path), assets = new Assets(path, db), outside = directory();
  try {
    expect(() => assets.path("../outside")).toThrow("Invalid resource hash");
    const bytes = Buffer.from("private"), digest = hash(bytes), file = join(outside, "keep");
    writeFileSync(file, bytes);
    mkdirSync(join(path, "assets"));
    symlinkSync(file, join(path, "assets", digest));
    expect(() => assets.read(digest, bytes.length)).toThrow();
    expect(() => readBounded(file, 2)).toThrow("size limit");
    rmSync(join(path, "assets"), { recursive: true });
    symlinkSync(outside, join(path, "assets"));
    expect(() => assets.write(digest, bytes)).toThrow("symbolic link");
    expect(readFileSync(file)).toEqual(bytes);
  } finally { db.close(); }
});

it("collects only unreferenced owned resources and retains image, source and audio snapshot dependencies", () => {
  const path = directory(), db = openPracticeDatabase(path), assets = new Assets(path, db);
  const save = (name: string, media: string) => { const bytes = Buffer.from(name), digest = hash(bytes); assets.write(digest, bytes); db.prepare("INSERT INTO assets VALUES(?,?,?,?)").run(digest, media, bytes.length, `assets/${digest}`); return digest; };
  try {
    const image = save("image", "image/png"), source = save("source page", "image/png"), orphan = save("unused", "image/png");
    const unregistered = hash("unregistered"); assets.write(unregistered, Buffer.from("unregistered"));
    db.exec("INSERT INTO sessions(id,bank_title,created_at,position,mode) VALUES('snapshot','Bank',0,0,'all')");
    const document = { visuals: [{ imageRef: { sha256: image }, sourceRef: { sha256: source } }], questions: ["No audio scan for image-only storage"] as unknown[] };
    db.prepare("INSERT INTO session_documents VALUES('snapshot',?)").run(JSON.stringify(document));
    assets.collect();
    expect(assets.bytes(image)).not.toBeNull(); expect(assets.bytes(source)).not.toBeNull(); expect(assets.bytes(orphan)).toBeNull();
    expect(existsSync(assets.path(orphan))).toBe(false); expect(existsSync(assets.path(unregistered))).toBe(false);
    const audio = save("audio", "audio/wav"); document.questions = [{ question: { audioRef: { sha256: audio } } }];
    db.prepare("UPDATE session_documents SET content=? WHERE session_id='snapshot'").run(JSON.stringify(document));
    assets.collect(); expect(assets.bytes(audio)).not.toBeNull();
    db.exec("DELETE FROM sessions WHERE id='snapshot'"); assets.collect();
    expect(db.prepare("SELECT COUNT(*) AS count FROM assets").get()!.count).toBe(0); expect(existsSync(assets.path(audio))).toBe(false);
  } finally { db.close(); }
});
