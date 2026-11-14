import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, cpus, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Run against two preserved desktop:build outputs; every child uses disposable data.
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
interface Sample { name: string; ms: number[]; hash: string }
async function probe(directory: string): Promise<Sample[]> {
  const load = (file: string) => import(pathToFileURL(join(directory, "app/desktop", `${file}.js`)).href);
  const [{ PracticeStore }, { readQuestions }, { feasibleCounts, queryQuestions }, { putContext }] = await Promise.all([load("store"), load("questions"), load("question-list"), load("bank-context")]);
  const temporary = mkdtempSync(join(tmpdir(), "practiq-performance-")), store = new PracticeStore(temporary), db = store.db;
  const report: Sample[] = [];
  function measure(name: string, perform: () => unknown, normalize = (value: unknown) => value) {
    const expected = digest(normalize(perform())), ms = [];
    for (let i = 0; i < 7; i++) {
      const started = performance.now(), value = perform(); ms.push(performance.now() - started);
      assert.equal(digest(normalize(value)), expected, name);
    }
    report.push({ name, ms, hash: expected });
  }
  try {
    db.exec("BEGIN IMMEDIATE");
    const bank = db.prepare("INSERT INTO banks VALUES(?,?,?,?)"), question = db.prepare("INSERT INTO questions(id,bank_id,parent_id,position,stem,mode,content_blocks,confidence,needs_review,missing_fields) VALUES(?,?,?,?,?,?,'[]',1,0,'[]')"), detail = db.prepare("INSERT INTO true_false_questions VALUES(?,'true')"), reading = db.prepare("INSERT INTO reading_questions VALUES(?,'[]')");
    bank.run("large", "Large", "", 2); bank.run("small", "Small", "", 1);
    const add = (id: string, bank: string, parent: string | null, position: number, mode = "true_false") => {
      question.run(id, bank, parent, position, `Question ${id}`, mode);
      (mode === "reading" ? reading : detail).run(id);
    };
    for (let i = 0; i < 20000; i++) add(`q${i}`, "large", null, i);
    add("small-root", "small", null, 0, "reading"); add("small-child", "small", "small-root", 1);
    for (let i = 0; i < 2000; i++) {
      add(`group${i}`, "large", null, 20000 + i * 4, "reading");
      for (let child = 0; child < 2 + i % 2; child++) add(`group${i}-${child}`, "large", `group${i}`, 20001 + i * 4 + child);
    }
    db.exec("COMMIT");
    const beforeRead = db.prepare("SELECT total_changes() AS n").get().n;
    measure("detail-small-in-large-db", () => readQuestions(db, store.assets, [], ["small-root"]));
    measure("bank-small-in-large-db", () => readQuestions(db, store.assets, ["small"]));
    measure("detail-20-in-large-db", () => readQuestions(db, store.assets, [], Array.from({ length: 20 }, (_, i) => `q${i}`)));
    measure("stats-27000-nodes", () => queryQuestions(db, { bank_ids: ["large"], mode: "", search: "", filter: "" }));
    measure("page-20-in-large-db", () => queryQuestions(db, { bank_ids: ["large"], mode: "", search: "", filter: "" }, { limit: 20, offset: 0 }));
    assert.equal(db.prepare("SELECT total_changes() AS n").get().n, beforeRead);
    for (const count of [20, 10000]) {
      const weights = Array.from({ length: count }, (_, i) => i % 4 + 1), original = digest(weights);
      measure(`feasible-${count}-mixed`, () => feasibleCounts(weights)); assert.equal(digest(weights), original);
    }
    const context = (count: number, groups: number, visuals: number) => ({
      warnings: ["Synthetic warning"], missingFields: ["analysis"],
      groups: Array.from({ length: groups }, (_, i) => ({ title: `Section ${i}`, instructions: null, questionIds: Array.from({ length: count }, (_, q) => `q${q}`) })),
      visualElements: Array.from({ length: visuals }, (_, i) => ({ kind: "figure", description: `Figure ${i}`, questionIds: Array.from({ length: count }, (_, q) => `q${q}`) })),
    });
    for (const [count, groups, visuals] of [[20, 2, 1], [500, 100, 20]]) {
      const input = context(count, groups, visuals), ids = new Map(Array.from({ length: count }, (_, i) => [`q${i}`, `q${i}`]));
      const diagnostics = [{ questionIds: [...ids.keys()], processing: { questionSources: [...ids.keys()].map(questionId => ({ questionId, stage: "document_parse", unitIndex: 0 })) } }];
      const normalize = () => [
        db.prepare("SELECT s.title,r.question_id FROM sections s JOIN section_questions r ON r.section_id=s.id ORDER BY s.title,r.question_id").all(),
        db.prepare("SELECT v.content,r.question_id FROM visuals v JOIN question_visuals r ON r.visual_id=v.id ORDER BY v.content,r.question_id").all(),
        db.prepare("SELECT * FROM question_sources ORDER BY question_id,stage,unit_index").all(), db.prepare("SELECT * FROM import_warnings ORDER BY import_id,position").all(),
      ];
      const original = digest([input, diagnostics]);
      measure(`context-${count}-${groups}-${visuals}`, () => {
        db.exec("BEGIN IMMEDIATE; DELETE FROM sections; DELETE FROM visuals; DELETE FROM question_sources; DELETE FROM imports; INSERT INTO imports VALUES('import','large','synthetic',0)");
        try { putContext(db, "large", input, ids, "import", diagnostics); } catch (error) { db.exec("ROLLBACK"); throw error; }
      }, () => {
        try { const result = normalize(); assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []); return result; }
        finally { db.exec("ROLLBACK"); }
      });
      assert.equal(digest([input, diagnostics]), original);
    }
    // Sparse associations expose attachment work separately from SQL selection.
    db.exec("BEGIN IMMEDIATE");
    const section = db.prepare("INSERT INTO sections VALUES(?,'large',?,NULL)"), link = db.prepare("INSERT INTO section_questions VALUES(?,?)"), visual = db.prepare("INSERT INTO visuals VALUES(?,'large',?,0)"), visualLink = db.prepare("INSERT INTO question_visuals VALUES(?,?)");
    for (let i = 0; i < 1000; i++) {
      section.run(`s${i}`, `Section ${i}`); visual.run(`v${i}`, JSON.stringify({ kind: "figure", description: `Figure ${i}` }));
      for (let j = 0; j < 2; j++) { link.run(`s${i}`, `q${i * 2 + j}`); visualLink.run(`v${i}`, `q${i * 2 + j}`); }
    }
    db.exec("COMMIT");
    measure("read-2000-sparse-associations", () => readQuestions(db, store.assets, [], Array.from({ length: 2000 }, (_, i) => `q${i}`)));
    return report;
  } finally { store.close(); rmSync(temporary, { recursive: true, force: true }); }
}

if (process.argv[2] === "--child") {
  process.stdout.write(JSON.stringify(await probe(resolve(process.argv[3]))));
} else {
  const [before, after, output] = process.argv.slice(2);
  assert(before && after && output, "Usage: node app/scripts/benchmark-performance.ts BEFORE_BUILD AFTER_BUILD NEW_REPORT.json");
  const runs: { variant: string; samples: Sample[] }[] = [];
  for (const order of [["before", "after"], ["after", "before"], ["before", "after"]]) for (const variant of order) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--child", resolve(variant === "before" ? before : after)], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 120000 });
    assert.equal(child.status, 0, child.stderr); runs.push({ variant, samples: JSON.parse(child.stdout) });
  }
  const summary = runs[0].samples.map(({ name, hash }) => {
    const samples = (variant: string) => runs.filter(run => run.variant === variant).flatMap(run => {
      const sample = run.samples.find(sample => sample.name === name)!; assert.equal(sample.hash, hash, `${variant}: ${name} output changed`); return sample.ms;
    });
    const beforeMs = median(samples("before")), afterMs = median(samples("after"));
    return { name, hash, beforeMs, afterMs, reductionPercent: (1 - afterMs / beforeMs) * 100 };
  });
  const hashes = (directory: string) => Object.fromEntries(["questions.js", "bank-context.js", "question-list.js", "execution-version.json"].map(file => [file, createHash("sha256").update(readFileSync(join(directory, "app/desktop", file))).digest("hex")]));
  writeFileSync(output, JSON.stringify({ scope: "Local compiled Node/SQLite synthetic operations; one warmup and seven samples in each of three isolated processes per variant, AB/BA/AB. Context timing excludes assertions, normalization and rollback; includes transaction entry and cleanup, excludes commit/fsync. No IPC, GUI, cold-cache, provider or installer latency.", environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0].model, memory: totalmem() }, builds: { before: hashes(resolve(before)), after: hashes(resolve(after)) }, summary, runs }, null, 2), { flag: "wx" });
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
}
