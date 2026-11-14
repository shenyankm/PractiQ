import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PracticeStore } from "./store.js";
import { BoundedZip, writeZip } from "./zip.js";
import { resourceReferences } from "./bank-packages.js";
import { canonical, readQuestions } from "./questions.js";
import { list, object } from "./question-contract.js";
import { readDiagnostics } from "./diagnostics.js";

const cleanup: (() => void)[] = [];
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "practiq-bank-packages-")), store = new PracticeStore(join(directory, "data"));
  cleanup.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); }); return { directory, store };
}
afterEach(() => { for (const remove of cleanup.splice(0)) remove(); });
const fixture = new URL("../fixtures/all-types.zip", import.meta.url).pathname;
const document = (questions: unknown[] = [{ id: "one", stem: "Question", answerMode: "true_false", answerPayload: { value: true } }]) => ({ schemaVersion: 3, questions, groups: [], visualElements: [], warnings: [], confidenceScore: 0 });
function preview(value: unknown): { ticket: string; title: string; count: number } { return value as { ticket: string; title: string; count: number }; }

it.skipIf(process.platform !== "darwin")("round-trips all existing question types and verified resources without study data", async () => {
  const { directory, store } = setup(), first = preview(await store.packages.previewZip(fixture));
  expect(first.count).toBe(20);
  const bank = store.packages.import(first.ticket, null, first.title);
  expect(bank.count).toBe(20);
  store.favorite(readQuestions(store.db, store.assets, [bank.bankId])[0].id, true);
  const destination = join(directory, "bank.zip"); await store.packages.export(bank.bankId, destination);
  const zip = await BoundedZip.open(destination, { archiveBytes: 300 * 1024 * 1024, expandedBytes: 300 * 1024 * 1024, entries: 2002 });
  let root: unknown;
  try {
    root = JSON.parse((await zip.read("questions.json", 32 * 1024 * 1024)).toString());
    expect(canonical(root)).not.toContain('"favorite"'); expect(canonical(root)).not.toContain('"latestResult"');
    expect(zip.entries.size).toBe(resourceReferences(root).size + 2);
  } finally { zip.close(); }
  const second = preview(await store.packages.previewZip(destination)), copy = store.packages.import(second.ticket, null, "Roundtrip");
  expect(copy.count).toBe(bank.count);
  const rows = readQuestions(store.db, store.assets, [copy.bankId]); expect(rows.every(row => !row.favorite && !row.missingAssets)).toBe(true);
  expect(rows.map(row => row.question.answerMode)).toEqual(readQuestions(store.db, store.assets, [bank.bankId]).map(row => row.question.answerMode));
});

it("keeps archived metadata, rejects oversized renames and retains a failed import preview", async () => {
  const { directory, store } = setup(), target = join(directory, "archived.zip"), title = "历史题库名称".repeat(8), description = "说明".repeat(40);
  await writeZip(target, [{ name: "manifest.json", data: Buffer.from(JSON.stringify({ format: "practiq-question-bank", version: 2, bank: { title, description } })) }, { name: "questions.json", data: Buffer.from(JSON.stringify(document())) }], 1024 * 1024);
  const p = preview(await store.packages.previewZip(target));
  expect(() => store.packages.import(p.ticket, null, "新名称".repeat(8))).toThrow("bank name");
  const bank = store.packages.import(p.ticket, null, p.title);
  expect(store.banksPage(10, 0).items[0]).toMatchObject({ id: bank.bankId, title, description });
  expect(() => store.packages.import(p.ticket, null, p.title)).toThrow("expired");
});

it("preserves partial empty content and diagnostics after append, deletion and repeated exports", async () => {
  const { directory, store } = setup(), partial = { ...document([]), groups: [{ title: "Unparsed section", instructions: "Retained passage", questionIds: [] }], visualElements: [{ kind: "image", description: "Unparsed source page", questionIds: [] }], missingFields: ["questions", "media"], warnings: ["Review the source", "PRACTIQ_MISSING:custom"] };
  const p = preview(store.packages.preview({ result: partial, status: "PARTIAL", processing: null }, "Partial")), bank = store.packages.import(p.ticket, null, "Partial");
  const next = preview(store.packages.preview(document(), "Append")); store.packages.import(next.ticket, bank.bankId, "Append");
  store.deleteQuestion(readQuestions(store.db, store.assets, [bank.bankId])[0].id);
  const target = join(directory, "partial.zip"); await store.packages.export(bank.bankId, target);
  const restored = preview(await store.packages.previewZip(target));
  expect(restored).toMatchObject({ count: 0, status: "PARTIAL", missingAssets: [] });
  expect(object(restored).groups).toEqual(partial.groups);
  expect(list(restored, "visuals")).toHaveLength(1);
  expect(object(restored).warnings).toEqual(partial.warnings);
  expect(list(restored, "importDiagnostics")).toHaveLength(1);
});

it("detects duplicate whole trees, ignores personal state and rejects stale comparisons", () => {
  const { store } = setup(), root = document(), p = preview(store.packages.preview(root, "First")), bank = store.packages.import(p.ticket, null, "First");
  store.favorite(readQuestions(store.db, store.assets, [bank.bankId])[0].id, true);
  const incoming = document([...root.questions, { id: "two", stem: "Another", answerMode: "true_false", answerPayload: { value: false } }]);
  const p2 = preview(store.packages.preview(incoming, "Second")), comparison = store.packages.duplicates(p2.ticket, bank.bankId);
  expect(comparison.groups).toEqual([{ id: "one", stem: "Question", count: 1 }]);
  const existing = readQuestions(store.db, store.assets, [bank.bankId])[0];
  store.request({ type: "save_question_tree", bank_id: bank.bankId, root_id: existing.id, questions: [{ ...existing.question, stem: "Edited" }] });
  expect(() => store.packages.import(p2.ticket, bank.bankId, "Second", true, comparison.check)).toThrow("changed");
  const refreshed = store.packages.duplicates(p2.ticket, bank.bankId); expect(refreshed.groups).toEqual([]);
  expect(store.packages.import(p2.ticket, bank.bankId, "Second", true, refreshed.check).count).toBe(2);
  const p3 = preview(store.packages.preview(incoming, "Same")); expect(store.packages.import(p3.ticket, bank.bankId, "Same")).toMatchObject({ duplicate: true, count: 0 });
});

it("skips a composite tree without orphaning shared options or unrelated document context", () => {
  const { store } = setup(), tree = document([
    { id: "parent", stem: "Material", answerMode: "word_bank", passage: [{ partType: "blank", questionId: "child" }], options: [{ label: "A", content: "Word" }] },
    { id: "child", parentId: "parent", optionSourceId: "parent", stem: "Choose", answerMode: "choice", choiceVariant: "single", answerPayload: { correct: ["A"] } },
  ]), p = preview(store.packages.preview(tree, "Composite")), bank = store.packages.import(p.ticket, null, "Composite");
  const p2 = preview(store.packages.preview({ ...tree, questions: [...tree.questions, { id: "extra", stem: "Extra", answerMode: "true_false" }] }, "Next")), comparison = store.packages.duplicates(p2.ticket, bank.bankId);
  expect(comparison.groups).toEqual([{ id: "parent", stem: "Material", count: 1 }]);
  expect(store.packages.import(p2.ticket, bank.bankId, "Next", true, comparison.check)).toMatchObject({ count: 1, skippedCount: 1 });
  expect(readQuestions(store.db, store.assets, [bank.bankId])).toHaveLength(3);
});

it("rejects undeclared files, corrupt resources and backup packages before changing study data", async () => {
  const { directory, store } = setup(), zip = await BoundedZip.open(fixture, { archiveBytes: 300 * 1024 * 1024, expandedBytes: 300 * 1024 * 1024, entries: 2002 });
  const entries: { name: string; data: Buffer }[] = [];
  try { for (const name of zip.entries.keys()) entries.push({ name, data: await zip.read(name, 32 * 1024 * 1024) }); } finally { zip.close(); }
  for (const kind of ["extra", "corrupt", "backup"]) {
    const modified = entries.map(entry => ({ ...entry }));
    if (kind === "extra") modified.push({ name: "unexpected", data: Buffer.from("secret") });
    if (kind === "corrupt") modified.find(entry => entry.name.startsWith("resources/"))!.data = Buffer.from("corrupt");
    if (kind === "backup") modified.find(entry => entry.name === "manifest.json")!.data = Buffer.from('{"format":"practiq-backup"}');
    const target = join(directory, `${kind}.zip`); await writeZip(target, modified, 300 * 1024 * 1024);
    await expect(store.packages.previewZip(target)).rejects.toThrow(); expect(store.banks()).toEqual([]);
  }
});

it("refuses export into application files and symbolic links without replacing existing bytes", async () => {
  const { directory, store } = setup(), p = preview(store.packages.preview(document(), "Safe")), bank = store.packages.import(p.ticket, null, "Safe"), db = join(store.directory, "practiq.sqlite"), before = readFileSync(db);
  await expect(store.packages.export(bank.bankId, db)).rejects.toThrow("outside"); expect(readFileSync(db)).toEqual(before);
  const real = join(directory, "real"), link = join(directory, "link.zip"); writeFileSync(real, "original"); symlinkSync(real, link);
  await expect(store.packages.export(bank.bankId, link)).rejects.toThrow(); expect(readFileSync(real, "utf8")).toBe("original");
});

it("merges independent copies while retaining unlinked content, source scope and personal favorites", async () => {
  const { directory, store } = setup();
  const partial = { result: { ...document(), visualElements: [{ kind: "image", description: "Only first bank", questionIds: [] }], groups: [{ title: "Unlinked", instructions: "Retain", questionIds: [] }], missingFields: ["media"] }, status: "PARTIAL", processing: null };
  const p = preview(store.packages.preview(partial, "First")), first = store.packages.import(p.ticket, null, "First"), firstRow = readQuestions(store.db, store.assets, [first.bankId])[0];
  store.favorite(firstRow.id, true); store.reviewQuestion(firstRow.id, true);
  const p2 = preview(store.packages.preview({ result: document([{ id: "two", stem: "Other", answerMode: "true_false" }]), status: "SUCCEEDED", processing: null }, "Second")), second = store.packages.import(p2.ticket, null, "Second");
  const merged = store.packages.merge([first.bankId, second.bankId], "Merged", "en"), rows = readQuestions(store.db, store.assets, [merged.bankId]);
  expect(rows.map(row => row.question.stem)).toEqual(["Question", "Other"]); expect(rows[0]).toMatchObject({ favorite: true, reviewedAt: null });
  expect(rows[0].visuals).toHaveLength(1); expect(rows[1].visuals).toHaveLength(0);
  expect(rows[0].id).not.toBe(firstRow.id); expect(readDiagnostics(store.db, merged.bankId)).toHaveLength(2);
  const target = join(directory, "merged.zip"); await store.packages.export(merged.bankId, target);
  const zip = await BoundedZip.open(target, { archiveBytes: 1024 * 1024, expandedBytes: 1024 * 1024, entries: 100 });
  try { const root = object(JSON.parse((await zip.read("questions.json", 1024 * 1024)).toString())); expect(root.status).toBe("PARTIAL"); expect(root.processing).toBeNull(); expect(object(root.result).missingFields).toEqual(["media"]); expect(list(root.result, "groups")).toHaveLength(1); } finally { zip.close(); }
  store.deleteBank(first.bankId); expect(readQuestions(store.db, store.assets, [merged.bankId])).toHaveLength(2);
  expect(() => store.packages.merge([second.bankId, second.bankId], "Invalid", "en")).toThrow();
  expect(() => store.packages.merge([second.bankId, "missing"], "Invalid", "en")).toThrow();
  expect(store.banks()).toHaveLength(2);
});

it("repairs old diagnostics only when content order and unique source evidence prove the mapping", async () => {
  const { store } = setup(), fixture = new URL("../fixtures/service-export/partial-media-bank.zip", import.meta.url).pathname;
  const p = preview(await store.packages.previewZip(fixture)), bank = store.packages.import(p.ticket, null, "Partial");
  store.db.exec("DELETE FROM import_warnings WHERE position=-1; UPDATE questions SET position=3-position");
  const reversed = preview(await store.packages.previewZip(fixture)); expect(store.packages.import(reversed.ticket, bank.bankId, "Partial").duplicate).toBe(true); expect(readDiagnostics(store.db, bank.bankId)).toEqual([]);
  store.db.exec("UPDATE questions SET position=3-position");
  const intact = preview(await store.packages.previewZip(fixture)); expect(store.packages.import(intact.ticket, bank.bankId, "Partial").duplicate).toBe(true); expect(readDiagnostics(store.db, bank.bankId)).toHaveLength(1);
  store.db.exec("DELETE FROM import_warnings WHERE position=-1; UPDATE questions SET stem='Edited' WHERE position=0");
  const edited = preview(await store.packages.previewZip(fixture)); store.packages.import(edited.ticket, bank.bankId, "Partial"); expect(readDiagnostics(store.db, bank.bankId)).toEqual([]);
});
