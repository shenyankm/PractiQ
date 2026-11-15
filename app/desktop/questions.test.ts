import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PracticeStore } from "./store.js";
import { Assets } from "./assets.js";
import { transaction } from "./database.js";
import { validateDocument } from "./document-contract.js";
import { validateQuestion, validateTree } from "./question-contract.js";
import { canonical, freeze, QuestionIndex, readQuestions, saveQuestionTree, thaw, writeQuestion } from "./questions.js";
import { putContext } from "./bank-context.js";
import type { Question } from "../src/contracts.generated.js";

const stores: PracticeStore[] = [];
function store() { const value = new PracticeStore(mkdtempSync(join(tmpdir(), "practiq-questions-"))); stores.push(value); return value; }
afterEach(() => { for (const value of stores.splice(0)) { value.close(); rmSync(value.directory, { recursive: true, force: true }); } });

it.each(["sample.json", "composite.json", "english.json"])("round-trips every type in the existing %s corpus through schema 11", file => {
  const source = validateDocument(JSON.parse(readFileSync(new URL(`../fixtures/${file}`, import.meta.url), "utf8")));
  const value = store(), bank = value.saveBank(null, "验证", ""), assets = new Assets(value.directory, value.db);
  const questions = source.questions as Question[];
  transaction(value.db, () => questions.forEach((q, i) => writeQuestion(value.db, q, bank, null, i, false, false)));
  const rows = readQuestions(value.db, assets, [bank]);
  expect(rows).toHaveLength(questions.length);
  for (const q of questions) {
    const actual = rows.find(row => row.id === q.id)!.question;
    expect(actual.answerMode).toBe(q.answerMode);
    expect(actual.answerPayload).toEqual(q.answerPayload ?? null);
    expect(actual.options).toEqual(q.options);
    expect(actual.items).toEqual(q.items.map(item => ({ id: null, side: null, content: null, label: null, ...item })));
    expect(actual.parentId).toBe(q.parentId ?? null);
    expect(actual.passage).toEqual(q.passage ?? []);
  }
  const copy = thaw(freeze(rows));
  expect(copy.map(row => row.question)).toEqual(rows.map(row => row.question));
  expect(canonical(freeze(copy))).toBe(canonical(freeze(rows)));
});

it("isolates tree edits, preserves favorite state and resets only changed review confirmations", () => {
  const value = store(), bank = value.saveBank(null, "验证", ""), assets = new Assets(value.directory, value.db);
  const question = { id: "one", stem: "Original", questionTypeId: "判断", answerMode: "true_false", answerPayload: { value: true }, analysis: "analysis", sourceText: "source", needsReview: false };
  expect(saveQuestionTree(value.db, assets, bank, null, [question])).toBe("one");
  value.db.exec("UPDATE questions SET favorite=1; INSERT INTO question_reviews VALUES('one',123)");
  const original = readQuestions(value.db, assets, [bank])[0].question;
  saveQuestionTree(value.db, assets, bank, "one", [original]);
  expect(readQuestions(value.db, assets)[0]).toMatchObject({ favorite: true, reviewedAt: 123 });
  saveQuestionTree(value.db, assets, bank, "one", [{ ...original, stem: "Changed" }]);
  expect(readQuestions(value.db, assets)[0]).toMatchObject({ favorite: true, reviewedAt: null });
  const other = value.saveBank(null, "other", "");
  expect(() => saveQuestionTree(value.db, assets, other, null, [question])).toThrow("another tree");
  expect(readQuestions(value.db, assets)[0].bankId).toBe(bank);
  expect(() => saveQuestionTree(value.db, assets, bank, "missing", [{ ...question, id: "missing" }])).toThrow("no longer exists");
});

it("hydrates shared options and ancestor material without exposing answer-bearing passage blocks", () => {
  const value = store(), bank = value.saveBank(null, "验证", ""), assets = new Assets(value.directory, value.db);
  const parent = validateQuestion({ id: "root", answerMode: "word_bank", questionTypeId: "word bank", stem: "Choose", options: [{ label: "A", content: "apple" }, { label: "B", content: "banana" }], passage: [{ partType: "text", textValue: "Material" }, { partType: "text", role: "analysis", textValue: "Hidden answer" }, { partType: "blank", questionId: "child" }] });
  const child = validateQuestion({ id: "child", parentId: "root", optionSourceId: "root", stem: "Choose a word", answerMode: "choice", choiceVariant: "single", questionTypeId: "single", answerPayload: { correct: ["A"] } });
  const tree = validateTree([parent, child]);
  saveQuestionTree(value.db, assets, bank, null, tree);
  const rows = readQuestions(value.db, assets, [], ["root"]), index = new QuestionIndex(rows), hydrated = index.snapshot("child");
  expect(hydrated.question.options).toEqual(parent.options);
  expect(hydrated.materials?.[0].passage?.some(block => block.textValue === "Hidden answer")).toBe(false);
  expect(rows.find(row => row.id === "root")?.question.passage?.some(block => block.textValue === "Hidden answer")).toBe(true);
  const document = freeze(rows), frozenBefore = canonical(document);
  value.db.exec("DELETE FROM questions WHERE id='root'");
  expect(new QuestionIndex(thaw(document)).snapshot("child").question.options).toEqual(parent.options);
  expect(canonical(document)).toBe(frozenBefore);
});

it("preserves scoped trees and association order across banks and absent references", () => {
  const value = store(), first = value.saveBank(null, "First", ""), second = value.saveBank(null, "Second", "");
  const q = (id: string) => ({ id, stem: id, answerMode: "true_false", questionTypeId: "判断", answerPayload: { value: true } });
  saveQuestionTree(value.db, value.assets, first, null, [{ id: "root", answerMode: "reading", questionTypeId: "阅读", stem: "Material" }, { ...q("child"), parentId: "root" }]);
  saveQuestionTree(value.db, value.assets, first, null, [q("sibling")]);
  saveQuestionTree(value.db, value.assets, second, null, [q("other")]);
  value.db.prepare("INSERT INTO imports VALUES('import',?,'digest',0)").run(first);
  transaction(value.db, () => putContext(value.db, first, {
    groups: [{ title: "Both", questionIds: ["child", "sibling"] }, { title: "Child", questionIds: ["child"] }],
    visualElements: [{ description: "All", questionIds: [] }, { description: "Scoped", questionIds: ["child", "sibling"] }, { description: "Hidden", documentOnly: true, questionIds: [] }],
  }, new Map(["root", "child", "sibling"].map(id => [id, id])), "import", []));
  const all = readQuestions(value.db, value.assets), subset = all.filter(row => row.id === "root" || row.id === "child");
  expect(readQuestions(value.db, value.assets, [], ["root"])).toEqual(subset);
  expect(readQuestions(value.db, value.assets, [first], ["root", "other", "absent"])).toEqual(subset);
  expect(readQuestions(value.db, value.assets, [second])).toEqual(all.filter(row => row.bankId === second));
  expect(readQuestions(value.db, value.assets, [], [])).toEqual([]);
  expect(readQuestions(value.db, value.assets, [], ["absent"])).toEqual([]);
  const child = subset.find(row => row.id === "child")!;
  expect(child.groups.map(group => group.title)).toEqual(["Both", "Child"]);
  expect(child.groups[0].questionIds).toEqual(["child", "sibling"]);
  expect(child.visuals.map(visual => visual.description)).toEqual(["All", "Scoped"]);
  expect(all.find(row => row.id === "other")!.visuals).toEqual([]);
  expect(value.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

it("restores ordered snapshot associations once per reference list without changing the source", () => {
  const value = store(), bank = value.saveBank(null, "Snapshot", "");
  saveQuestionTree(value.db, value.assets, bank, null, [{ id: "q0", stem: "Source", answerMode: "true_false", answerPayload: { value: true } }]);
  const sample = readQuestions(value.db, value.assets)[0], rows = Array.from({ length: 20 }, (_, i) => ({ ...sample, id: `q${i}`, question: { ...sample.question, id: `q${i}` } }));
  let reads = 0;
  const groups = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, title: `Section ${i}`, get questionIds() { reads++; return [`q${i * 2}`, `q${i * 2 + 1}`, `q${i * 2}`, "absent"]; } }));
  const visuals = [{ id: "all", questionIds: [] }, ...groups.map(group => ({ id: `v${group.id}`, get questionIds() { return group.questionIds; } }))];
  const document = { schemaVersion: 3, questions: rows, groups, visuals }, original = structuredClone(document);
  reads = 0;
  const restored = thaw(document);
  expect(reads).toBeLessThanOrEqual(groups.length * 4);
  expect(restored[0].groups.map(group => group.id)).toEqual(["s0"]);
  expect(restored[0].visuals.map(visual => visual.id)).toEqual(["all", "vs0"]);
  expect(restored[19].groups.map(group => group.id)).toEqual(["s9"]);
  expect(document).toEqual(original);
  restored[0].question.stem = "Changed copy";
  expect(rows[0].question.stem).toBe("Source");
});

it("preserves dense, empty, duplicate and absent snapshot associations exactly", () => {
  const value = store(), bank = value.saveBank(null, "Snapshot", "");
  saveQuestionTree(value.db, value.assets, bank, null, [{ id: "one", stem: "Source", answerMode: "true_false", answerPayload: { value: false } }]);
  const sample = readQuestions(value.db, value.assets)[0];
  const rows = ["c", "a", "a", "b"].map((id, i) => ({ ...sample, id, question: { ...sample.question, id, stem: String(i) } }));
  const groups = [{ id: "empty", questionIds: [] }, { id: "dense", questionIds: ["b", "a", "c", "a", "absent", null, 1] }, { id: "dense", questionIds: ["a"] }];
  const visuals = [{ id: "all", questionIds: [] }, { id: "absent", questionIds: ["absent"] }, { id: "scoped", questionIds: ["a", "a", "b"] }];
  for (const questions of [rows, rows.slice(0, 1), []]) {
    const document = { schemaVersion: 3, questions, groups, visuals }, original = structuredClone(document);
    const expected = structuredClone(questions).map(row => ({ ...row, groups: groups.filter(group => group.questionIds.includes(row.id)), visuals: visuals.filter(visual => !visual.questionIds.length || visual.questionIds.includes(row.id)) }));
    expect(thaw(document)).toEqual(expected);
    expect(document).toEqual(original);
  }
  expect(() => thaw({ schemaVersion: 2, questions: [], groups: [], visuals: [] })).toThrow("Unsupported session snapshot");
  expect(() => thaw({ schemaVersion: 3, questions: [], groups: [null], visuals: [] })).toThrow("Invalid snapshot field");
  expect(() => thaw({ schemaVersion: 3, questions: [{ question: null }], groups: [], visuals: [] })).toThrow("Invalid snapshot question");
});
