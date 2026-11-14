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
