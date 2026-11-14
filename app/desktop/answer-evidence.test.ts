import { expect, it } from "vitest";
import { retainSourceAnswers } from "./answer-evidence.js";
import { validateParsedQuestion } from "./question-contract.js";

const makeQuestion = (patch: Record<string, unknown> = {}) => validateParsedQuestion({ id: "q:1", stem: "Prompt?", answerMode: "short_answer", answerPayload: { text: "Supplied" }, sourceText: "Prompt?", ...patch });
const choice = (correct = ["A"]) => makeQuestion({ answerMode: "choice", choiceVariant: correct.length > 1 ? "multiple" : "single", options: [{ label: "A", content: "Alpha" }, { label: "B", content: "Beta" }], answerPayload: { correct } });

it("preserves supplied answer and explanation fields without changing unrelated metadata", () => {
  const questions = [makeQuestion({ analysis: "Explanation", confidence: 0.83, sourceScore: 4 })], before = structuredClone(questions);
  expect(retainSourceAnswers(questions, "1. Prompt?\nAnswer: Supplied\nAnalysis: Explanation", [])).toEqual([]);
  expect(questions).toEqual(before);
});

it.each(["answerPayload", "analysis"])("removes only an unproven %s field and keeps the other supplied field", field => {
  const question = makeQuestion({ analysis: "Explanation", sourceScore: 4, confidence: 0.83 });
  const text = `1. Prompt?\nAnswer: ${field === "answerPayload" ? "Other" : "Supplied"}\nAnalysis: ${field === "analysis" ? "Other" : "Explanation"}`;
  expect(retainSourceAnswers([question], text, [])).toEqual([[0, [field]]]);
  expect(question).toMatchObject({ id: "q:1", stem: "Prompt?", sourceScore: 4, confidence: 0.83, needsReview: true });
  expect(question[field]).toBeNull();
  expect(field === "analysis" ? question.answerPayload : question.analysis).toEqual(field === "analysis" ? { text: "Supplied" } : "Explanation");
});

it.each(["", "1. Different question\nAnswer: Supplied", "1. Prompted question\nAnswer: Supplied"])("does not borrow evidence for an absent or different PRIMARY question: %s", primary => {
  const question = makeQuestion({ stem: "Prompt" });
  expect(retainSourceAnswers([question], primary, ["1. Prompt\nAnswer: Supplied"])).toEqual([[0, ["answerPayload"]]]);
});

it("uses printed identities to disambiguate repeated stems without borrowing a neighboring answer", () => {
  const text = "1. Prompt?\nAnswer: First\n2. Prompt?\nAnswer: Second";
  const questions = [makeQuestion({ id: "q:1", answerPayload: { text: "First" } }), makeQuestion({ id: "q:2", answerPayload: { text: "Second" } })];
  expect(retainSourceAnswers(questions, text, [])).toEqual([]);
  questions[1].answerPayload = { text: "First" };
  expect(retainSourceAnswers(questions, text, [])).toEqual([[1, ["answerPayload"]]]);
});

it("uses a separate answer key only for a uniquely owned source number", () => {
  const primary = "17. Prompt?", key = "Answer key\n17. Supplied", question = makeQuestion({ id: "page:1:17" });
  expect(retainSourceAnswers([question], primary, [key])).toEqual([]);
  expect(retainSourceAnswers([makeQuestion()], primary, ["17. Different question?\n" + key])).toEqual([[0, ["answerPayload"]]]);
  expect(retainSourceAnswers([makeQuestion()], primary + "\n" + key + "\n17. Supplied", [])).toEqual([[0, ["answerPayload"]]]);
});

it("requires the exact quoted slot when parsing an explicit answer sheet", () => {
  const primary = "7. Supplied\n8. Different", question = makeQuestion({ sourceText: "7. Supplied" });
  expect(retainSourceAnswers([question], primary, [], true)).toEqual([]);
  expect(retainSourceAnswers([makeQuestion({ sourceText: "8. Different" })], primary, [], true)).toEqual([[0, ["answerPayload"]]]);
  expect(retainSourceAnswers([makeQuestion({ sourceText: "9. Supplied" })], primary, [], true)).toEqual([[0, ["answerPayload"]]]);
});

it.each(["A", "a.", "A。", '["A"]', '{"correct":["A"]}'])("preserves a supplied choice expressed as %s", answer => {
  expect(retainSourceAnswers([choice()], `1. Prompt?\nA. Alpha\nB. Beta\nAnswer: ${answer}`, [])).toEqual([]);
});

it.each(["AB", "B, A", "A B", '["B","A"]'])("preserves unordered multiple-choice labels expressed as %s", answer => {
  expect(retainSourceAnswers([choice(["A", "B"])], `1. Prompt?\nA. Alpha\nB. Beta\nAnswer: ${answer}`, [])).toEqual([]);
});

it.each(["Unknown", "Not supplied", "C", '{"correct":[1]}'])("keeps an unavailable or mismatched choice unproven: %s", answer => {
  expect(retainSourceAnswers([choice()], `1. Prompt?\nA. Alpha\nB. Beta\nAnswer: ${answer}`, [])).toEqual([[0, ["answerPayload"]]]);
});

it.each([{ value: true, tokens: ["true", "True", "正确", "对", "✓"] }, { value: false, tokens: ["false", "错误", "否", "×"] }])("preserves literal true/false equivalents for $value", ({ value, tokens }) => {
  for (const token of tokens) expect(retainSourceAnswers([makeQuestion({ answerMode: "true_false", answerPayload: { value } })], `1. Prompt?\nAnswer: ${token}`, [])).toEqual([]);
  expect(retainSourceAnswers([makeQuestion({ answerMode: "true_false", answerPayload: { value } })], "1. Prompt?\nAnswer: 1", [])).toEqual([[0, ["answerPayload"]]]);
});

it.each(['["one","two"]', '["two","one"]', '["one",2]', '["one"]'])("preserves fill-answer type, order and count: %s", answer => {
  const question = makeQuestion({ answerMode: "fill_blank", blankCount: 2, answerPayload: { answers: ["one", "two"] } });
  expect(retainSourceAnswers([question], `1. Prompt?\nAnswer: ${answer}`, [])).toEqual(answer === '["one","two"]' ? [] : [[0, ["answerPayload"]]]);
});

const ordering = () => makeQuestion({ stem: "Arrange?", answerMode: "ordering", items: [{ id: 7, content: "Two" }, { id: 8, content: "One" }], answerPayload: { order: [8, 7] } });
it.each(["8, 7", "[8,7]", '{"order":[8,7]}'])("retains verified ordering identities for %s", answer => {
  expect(retainSourceAnswers([ordering()], `Ordering — Arrange?\nItems: 7. Two; 8. One.\nAnswer: ${answer}`, [])).toEqual([]);
});
it.each(["[8.0,7]", '{"order":[8,7.0]}', "7,8"])("rejects source numeric-type changes and reordered identities: %s", answer => {
  expect(retainSourceAnswers([ordering()], `Ordering — Arrange?\nItems: 7. Two; 8. One.\nAnswer: ${answer}`, [])).toEqual([[0, ["answerPayload"]]]);
});
it("requires every literal item before trusting an ordering answer", () => {
  expect(retainSourceAnswers([ordering()], "Ordering — Arrange?\nItems: 7. Changed item; 8. One.\nAnswer: 8, 7", [])).toEqual([[0, ["answerPayload"]]]);
});

it.each(["left 7 -> right 4; left 8 -> right 5", '{"matches":[{"left":7,"right":4},{"left":8,"right":5}]}'])("retains supplied matching identities: %s", answer => {
  const question = makeQuestion({ stem: "Match?", answerMode: "matching", matchingVariant: "one_to_one", items: [{ id: 7, side: "left", content: "Cat" }, { id: 8, side: "left", content: "Dog" }, { id: 4, side: "right", content: "cat" }, { id: 5, side: "right", content: "dog" }], answerPayload: { matches: [{ left: 7, right: 4 }, { left: 8, right: 5 }] } });
  expect(retainSourceAnswers([question], `Matching — Match?\nLeft: 7. Cat; 8. Dog.\nRight: 4. cat; 5. dog.\nAnswer: ${answer}`, [])).toEqual([]);
});

it.each(["translation", "writing"])("requires the literal material and source score for an unnumbered %s answer", questionKind => {
  const question = makeQuestion({ stem: "Complete this task.", questionKind, sourceScore: 10, contentBlocks: [{ partType: "text", role: "source_text", textValue: "Printed material" }] });
  const source = `${questionKind === "translation" ? "Translation" : "Writing"}: Complete this task. (10 points)\nPrinted material\nReference answer: Supplied`;
  expect(retainSourceAnswers([question], source, [])).toEqual([]);
  question.sourceScore = 11;
  expect(retainSourceAnswers([question], source, [])).toEqual([[0, ["answerPayload"]]]);
});

it("preserves only supplied tabular answers and independent analysis evidence", () => {
  const source = 'id\tstem\tanswer\tanswer_status\tevidence\n1\tPrompt?\tSupplied\tsupplied\t{"analysis":"Explanation"}';
  expect(retainSourceAnswers([makeQuestion({ analysis: "Explanation" })], source, [])).toEqual([]);
  const question = makeQuestion({ analysis: "Explanation" });
  expect(retainSourceAnswers([question], source.replace("\tsupplied\t", "\tgenerated\t"), [])).toEqual([[0, ["answerPayload"]]]);
  expect(question.analysis).toBe("Explanation");
});

it("does not reinterpret null or unknown source values as supplied short answers", () => {
  for (const value of ["null", "N/A", "Not supplied", '{"text":null}']) expect(retainSourceAnswers([makeQuestion()], `1. Prompt?\nAnswer: ${value}`, [])).toEqual([[0, ["answerPayload"]]]);
});

it("does not borrow an explanation from the next section or a supplementary passage", () => {
  for (const heading of ["Section: Other", "Supplemental reading:"]) {
    const question = makeQuestion({ analysis: "Borrowed explanation" });
    expect(retainSourceAnswers([question], `1. Prompt?\nAnswer: Supplied\n${heading}\nAnalysis: Borrowed explanation`, [])).toEqual([[0, ["analysis"]]]);
  }
});

it.each([
  { printed: "1.0", expected: "1.0", keep: true }, { printed: "1.0", expected: "1", keep: false },
  { printed: "-0.0", expected: "0", keep: false }, { printed: "1e-6", expected: "0.000001", keep: false },
  { printed: "true", expected: "true", keep: true }, { printed: "true", expected: "True", keep: false },
  { printed: "1.", expected: "1", keep: true },
])("keeps literal scalar spelling rather than JavaScript coercion: $printed / $expected", ({ printed, expected, keep }) => {
  const question = makeQuestion({ answerPayload: { text: expected } });
  expect(retainSourceAnswers([question], `1. Prompt?\nAnswer: ${printed}`, [])).toEqual(keep ? [] : [[0, ["answerPayload"]]]);
});

it("does not trust duplicate or misaligned source-table columns", () => {
  for (const table of ["stem\tstem\tanswer\nPrompt?\tOther\tSupplied", "stem\tanswer\nPrompt?\tSupplied\tExtra cell"]) {
    expect(retainSourceAnswers([makeQuestion()], table, [])).toEqual([[0, ["answerPayload"]]]);
  }
});

function gapQuestions(cloze = false) {
  const options = [{ label: "A", content: "white" }, { label: "B", content: "green" }];
  const parent = makeQuestion({ id: "p", stem: "Complete the sentence", answerMode: cloze ? "cloze" : "word_bank", answerPayload: null, options: cloze ? [] : options, passage: [{ partType: "text", textValue: "Snow is " }, { partType: "blank", questionId: "c1" }, { partType: "text", textValue: ". Grass is " }, { partType: "blank", questionId: "c2" }, { partType: "text", textValue: "." }] });
  return [parent, ...["Snow is", "Grass is"].map((stem, i) => makeQuestion({ id: `c${i + 1}`, parentId: "p", optionSourceId: cloze ? null : "p", stem, answerMode: "choice", choiceVariant: "single", options: cloze ? i ? [{ label: "A", content: "red" }, { label: "B", content: "green" }] : options : [], answerPayload: { correct: [i ? "B" : "A"] } }))];
}
const bankSource = "Word bank — Complete the sentence\nBank: A. white B. green.\nSnow is [1]. Grass is [2].\nAnswers: 1 A; 2 B";

it("matches word-bank answers to the literal material, shared options and each unique blank", () => {
  const questions = gapQuestions();
  expect(retainSourceAnswers(questions, bankSource, [])).toEqual([]);
  expect(questions.slice(1).map(q => q.answerPayload)).toEqual([{ correct: ["A"] }, { correct: ["B"] }]);
});

it.each(["changed-option", "duplicate-blank", "foreign-answer-number", "unsupported-separator"])("rejects ambiguous or inconsistent word-bank evidence: %s", fault => {
  let source = bankSource;
  if (fault === "changed-option") source = source.replace("A. white", "A. yellow");
  else if (fault === "duplicate-blank") source = source.replace("[2]", "[1]");
  else if (fault === "unsupported-separator") source = source.replace("A. white B. green", "A. white; B. green");
  else source += "; 3 A";
  expect(retainSourceAnswers(gapQuestions(), source, [])).toEqual([[1, ["answerPayload"]], [2, ["answerPayload"]]]);
});

it("does not fill an omitted blank answer or attach a shared explanation to a specific child", () => {
  expect(retainSourceAnswers(gapQuestions(), bankSource.replace("; 2 B", ""), [])).toEqual([[2, ["answerPayload"]]]);
  const questions = gapQuestions(); questions[1].analysis = "Shared explanation";
  expect(retainSourceAnswers(questions, bankSource + "\nAnalysis: Shared explanation", [])).toEqual([[1, ["analysis"]]]);
  expect(questions[1].answerPayload).toEqual({ correct: ["A"] });
});

it("requires each cloze blank's own option section and preserves its numbered answer", () => {
  const source = "Cloze — Complete the sentence\nSnow is [1]. Grass is [2]. 1: A. white B. green 2: A. red B. green\nAnswers: 1 A; 2 B";
  expect(retainSourceAnswers(gapQuestions(true), source, [])).toEqual([]);
  expect(retainSourceAnswers(gapQuestions(true), source.replace("2: A. red", "3: A. red"), [])).toEqual([[1, ["answerPayload"]], [2, ["answerPayload"]]]);
});

it("retains printed paragraph labels and permitted reuse without substituting internal JSON identities", () => {
  const question = makeQuestion({ stem: "Match statements", answerMode: "matching", questionKind: "paragraph_matching", matchingVariant: "many_to_one", items: [{ id: 0, label: "1", side: "left", content: "Early opening." }, { id: 1, label: "2", side: "left", content: "Borrow books." }, { id: 0, label: "A", side: "right", content: "Library opens early and lends books." }, { id: 1, label: "B", side: "right", content: "Sports centre." }], answerPayload: { matches: [{ left: 0, right: 0 }, { left: 1, right: 0 }] } });
  const source = "Paragraph matching: Match statements\nParagraphs may be used more than once.\n1. Early opening.\n2. Borrow books.\nA. Library opens early and lends books.\nB. Sports centre.\nAnswers: 1-A, 2-A";
  expect(retainSourceAnswers([question], source, [])).toEqual([]);
  expect(retainSourceAnswers([question], source.replace("1-A, 2-A", '{"matches":[{"left":0,"right":0},{"left":1,"right":0}]}'), [])).toEqual([[0, ["answerPayload"]]]);
});

it("leaves questions with no supplied answer fields unchanged", () => {
  const questions = [makeQuestion({ answerPayload: null, analysis: null })], before = structuredClone(questions);
  expect(retainSourceAnswers(questions, "No supplied answers", [])).toEqual([]); expect(questions).toEqual(before);
});
it("indexes a large source without borrowing answers or mutating unrelated metadata", () => {
  const count = 4000, questions = Array.from({ length: count }, (_, index) => validateParsedQuestion({ id: `q:${index + 1}`, stem: `Prompt ${index}?`, answerMode: "short_answer", answerPayload: { text: `Answer ${index}` } }));
  const source = questions.map((q, index) => `${index + 1}. ${q.stem}\nAnswer: Answer ${index}`).join("\n");
  const original = structuredClone(questions); expect(retainSourceAnswers(questions, source, [])).toEqual([]); expect(questions).toEqual(original);
  questions[2000].answerPayload = { text: "Answer 1999" }; expect(retainSourceAnswers(questions, source, [])).toEqual([[2000, ["answerPayload"]]]);
});
