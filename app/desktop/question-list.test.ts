import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PracticeStore } from "./store.js";
import { feasibleCounts, queryQuestions } from "./question-list.js";
import type { QuestionPage, QuestionStats } from "../src/api.js";

const stores: PracticeStore[] = [];
function setup() {
  const store = new PracticeStore(mkdtempSync(join(tmpdir(), "practiq-search-"))); stores.push(store);
  const bank = store.saveBank(null, "验证", "");
  const save = (questions: unknown[]) => store.request({ type: "save_question_tree", bank_id: bank, root_id: null, questions });
  const q = (id: string, stem: string) => ({ id, stem, questionTypeId: "判断", answerMode: "true_false", answerPayload: { value: true }, sourceText: "original", analysis: "explanation", needsReview: false });
  save([q("one", "A literal schemaVersion word")]);
  save([{ id: "root", stem: "Shared material", answerMode: "reading", questionTypeId: "阅读", passage: [{ partType: "text", textValue: "Ancestor needle" }] }, { ...q("child-a", "Child A"), parentId: "root" }, { ...q("child-b", "Child B"), parentId: "root" }]);
  save([{ ...q("last", "Final item"), answerMode: "short_answer", answerPayload: { text: "Reference keyword" } }]);
  const query = { bank_ids: [bank], search: "", mode: "", filter: "" };
  return { store, bank, query };
}
afterEach(() => { for (const store of stores.splice(0)) { store.close(); rmSync(store.directory, { recursive: true, force: true }); } });

it("keeps stable root pagination and group-aware statistics", () => {
  const { store, query } = setup();
  const page = queryQuestions(store.db, query, { limit: 2, offset: 0 }) as QuestionPage;
  expect(page.total).toBe(3);
  expect(page.items.map(item => item.id)).toEqual(["one", "root"]);
  expect(page.items[1].answerableCount).toBe(2);
  const last = queryQuestions(store.db, query, { limit: 2, offset: 999 }) as QuestionPage;
  expect(last.offset).toBe(2);
  expect(last.items.map(item => item.id)).toEqual(["last"]);
  const stats = queryQuestions(store.db, query) as QuestionStats;
  expect(stats).toEqual({ count: 4, types: { true_false: 1, reading: 1, short_answer: 1 }, feasibleCounts: [1, 2, 3, 4] });
  expect((queryQuestions(store.db, { ...query, mode: "short_answer" }, { limit: 10, offset: 0 }, true) as QuestionPage).items.map(item => item.id)).toEqual(["last"]);
  expect(() => queryQuestions(store.db, { ...query, mode: "reading,reading" })).toThrow("Invalid question type");
});

it("searches content and supplied answers without matching unrelated schema metadata", () => {
  const { store, query } = setup();
  const ids = (search: string) => (queryQuestions(store.db, { ...query, search }, { limit: 10, offset: 0 }) as QuestionPage).items.map(item => item.id);
  expect(ids("ancestor NEEDLE")).toEqual(["root"]);
  expect(ids("Reference keyword")).toEqual(["last"]);
  expect(ids("schemaVersion")).toEqual(["one"]);
  expect(ids("confidence")).toEqual([]);
  expect(ids("true_false")).toEqual([]);
});

it("keeps wrong-answer search scoped to eligible descendants and inherited material", () => {
  const { store, query } = setup();
  store.db.exec("INSERT INTO sessions(id,bank_title,created_at,position,mode) VALUES('session','test',1,0,'ordered')");
  store.db.prepare("INSERT INTO attempts(session_id,ordinal,question_id,snapshot_question_id,submitted_at,result) VALUES('session',0,'child-a','child-a',100,0)").run();
  const wrong = { ...query, filter: "wrong" };
  const ids = (search: string) => (queryQuestions(store.db, { ...wrong, search }, { limit: 10, offset: 0 }) as QuestionPage).items.map(item => item.id);
  expect(ids("")).toEqual(["root"]);
  expect(ids("Child A")).toEqual(["root"]);
  expect(ids("Child B")).toEqual([]);
  expect(ids("Ancestor needle")).toEqual(["root"]);
  const page = queryQuestions(store.db, wrong, { limit: 10, offset: 0 }) as QuestionPage;
  expect(page.items[0].hasWrong).toBe(true);
});

it("applies favorite and review flags to complete groups and removes reviewed descendants from review filters", () => {
  const { store, query } = setup();
  store.favorite("root", true);
  expect((queryQuestions(store.db, { ...query, filter: "favorite" }, { limit: 10, offset: 0 }) as QuestionPage).items.map(item => item.id)).toEqual(["root"]);
  expect(store.questionDetail("root").children?.every(child => child.favorite)).toBe(true);
  expect((queryQuestions(store.db, { ...query, filter: "review" }, { limit: 10, offset: 0 }) as QuestionPage).items.some(item => item.id === "root")).toBe(true);
  store.reviewQuestion("root", true);
  expect((queryQuestions(store.db, { ...query, filter: "review" }, { limit: 10, offset: 0 }) as QuestionPage).items.some(item => item.id === "root")).toBe(false);
  expect(() => store.reviewQuestion("child-a", true)).toThrow("complete question");
  expect(() => store.deleteQuestion("child-a")).toThrow("complete question");
  store.deleteQuestion("root");
  expect(store.db.prepare("SELECT count(*) AS count FROM questions WHERE parent_id='root'").get()?.count).toBe(0);
});

it("computes achievable counts without splitting composite groups", () => {
  expect(feasibleCounts([2, 2, 2])).toEqual([2, 4, 6]);
  expect(feasibleCounts([2, 3])).toEqual([2, 3, 5]);
  expect(feasibleCounts([0, 1001])).toEqual([]);
  expect(feasibleCounts(Array(2000).fill(1))).toHaveLength(1000);
});
