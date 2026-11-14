import { expect, it } from "vitest";
import { ocrSourceEvidence, type TencentPage } from "./tencent-bundle.js";

const page = (layout: string): TencentPage => ({ page: 1, format: "table", figures: [], elements: [{ layout_xml: layout, table_info: { table_name: "Science", fields: [{ formatted_field_name: "Listening:_A_source_title" }] } }] });
it("uses exact native XML cells and worksheet identity for trusted OCR field checks", () => {
  expect(ocrSourceEvidence(page('<table><tr><td>Listening: A source title</td></tr><tr><td>Section: Part A &amp; B</td></tr></table>'))).toEqual({ text: "Listening: A source title\nSection: Part A & B", nativeTable: { title: "Science", headers: ["Listening:_A_source_title"] } });
});
it("keeps nested cell iteration order and excludes namespaced cells without discarding their parent text", () => {
  expect(ocrSourceEvidence(page('<table><td>A<table><td>B</td></table>C<x:td xmlns:x="urn:test">D</x:td></td><td><![CDATA[ E ]]></td></table>')).text).toBe("ABCD\nB\n E ");
});
it("uses original evidence lines when native XML is absent", () => {
  expect(ocrSourceEvidence({ page: 1, figures: [], elements: [{ text_info: { content: "First\r\nSecond\u0085Third" } }] })).toEqual({ text: "First\nSecond\nThird" });
});
it.each(['<!DOCTYPE table [<!ENTITY a "PRIVATE">]><table><td>&a;</td></table>', '<table><td>Unclosed', '<table>'.repeat(129) + '</table>'.repeat(129)])("rejects unsafe or malformed XML source evidence before model work", xml => {
  expect(() => ocrSourceEvidence(page(xml))).toThrow();
});

import { validateSourceFields } from "./source-fields.js";
import { validateParsedQuestion } from "./question-contract.js";
import { sourceFidelityViolations, ocrPageViolations } from "./source-fidelity.js";
const parsed = (input: Record<string, unknown>) => validateParsedQuestion({ answerMode: "short_answer", ...input });
it.each(["Reading comprehension — ", "Word bank – ", "Cloze — ", "Ordering — ", "Matching — ", "Multiple choice: ", "True or false：", "Fill in the blank: ", "Short answer: ", "Grammar fill: ", "Sentence selection: ", "１２. Short answer: ", "Fıll ın the blank: ", "ſhort anſwer: "])("removes a printed prefix only with matching literal evidence: %s", prefix => {
  const stem = prefix + "Q?";
  expect(sourceFidelityViolations([parsed({ stem, sourceText: stem })])).not.toEqual([]);
  expect(sourceFidelityViolations([parsed({ stem, sourceText: "Different source" })])).toEqual([]);
});
it.each([
  { kind: "reading", mode: "reading", heading: "Reading comprehension— " },
  { kind: "word_bank", mode: "word_bank", heading: "Word bank— " },
  { kind: "cloze", mode: "cloze", heading: "Cloze— " },
  { kind: "grammar_fill", mode: "gap_fill", heading: "Grammar fill: " },
  { kind: "sentence_selection", mode: "word_bank", heading: "Sentence selection: " },
  { kind: "listening", mode: "listening", heading: "Listening: " },
  { kind: "paragraph_matching", mode: "matching", heading: "Paragraph matching: " },
  { kind: "ordering", mode: "ordering", heading: "Ordering— " },
  { kind: "matching", mode: "matching", heading: "Matching— " },
])("retains a literal $kind title and refuses an invented one", ({ kind, mode, heading }) => {
  const question = { ...parsed({ answerMode: mode, stem: "Oak", sourceText: heading + "Oak" }), questionKind: kind };
  expect(sourceFidelityViolations([question])).toEqual([]);
  if (!["listening", "paragraph_matching"].includes(kind)) expect(sourceFidelityViolations([{ ...question, stem: "Invented" }])[0]).toContain("Preserve the printed exercise title");
  expect(sourceFidelityViolations([question], { text: "# " + heading + "Oak" })).toEqual([]);
  expect(sourceFidelityViolations([{ ...question, sourceText: "Unrelated", stem: "Invented" }], { text: "# " + heading + "Oak" })[0]).toContain("Preserve the printed exercise title");
});
it("requires a unique verbatim passage before separating a title from material", () => {
  const question = parsed({ answerMode: "reading", stem: "Oak", sourceText: "Reading comprehension — Oak Article: The oak is tall.", passage: [{ partType: "text", textValue: "The oak is tall." }] });
  expect(sourceFidelityViolations([question])).toEqual([]);
  expect(sourceFidelityViolations([{ ...question, stem: "Wrong" }])[0]).toContain("Oak");
  expect(sourceFidelityViolations([{ ...question, stem: "Reading comprehension — Oak", sourceText: "Unrelated" }], { text: "Unrelated" })).toEqual([]);
});
it.each([
  { heading: "Reading comprehension", cue: "Article: A source passage." },
  { heading: "Word bank", cue: "Bank: A. red B. blue" },
  { heading: "Cloze", cue: "Passage: Fill [1]." },
  { heading: "Grammar fill", cue: "Words (1) ____ here." },
  { heading: "Listening", cue: "Transcript: A conversation." },
])("requires a separate parent only with a proven $heading heading and cue", ({ heading, cue }) => {
  const question = parsed({ stem: "Title" }); expect(ocrPageViolations([question], [], { text: `# ${heading}: Title\n${cue}` })[0]).toContain("require a separate"); expect(ocrPageViolations([question], [], { text: cue })).toEqual([]);
});
it("requires exact worksheet ownership and only explicit section groups", () => {
  const questions = [parsed({ stem: "Q" })], evidence = { text: "Section: Part A", nativeTable: { title: "Science", headers: ["Question"] } };
  expect(ocrPageViolations(questions, [{ title: "Science", questionIndexes: [0] }, { title: "Part A", questionIndexes: [0] }], evidence)).toEqual([]);
  expect(ocrPageViolations(questions, [], evidence)[0]).toContain("native worksheet group");
  expect(ocrPageViolations(questions, [{ title: "Question", questionIndexes: [0] }], evidence).join(" ")).toContain("column headers");
  expect(ocrPageViolations(questions, [{ title: "Science", questionIndexes: [0] }, { title: "Invented", questionIndexes: [0] }], evidence).join(" ")).toContain("literal explicit Section");
});
it("keeps passage punctuation and only replaces the actual blank marker", () => {
  const passage = [{ partType: "text", textValue: "Snow is " }, { partType: "blank", questionId: "child" }, { partType: "text", textValue: "." }], question = parsed({ stem: "Title", answerMode: "word_bank", passage });
  expect(ocrPageViolations([question], [], { text: "Snow is [1]." })).toEqual([]);
  expect(ocrPageViolations([{ ...question, passage: passage.slice(0, 2) }], [], { text: "Snow is [1]." })[0]).toContain("punctuation");
  const grammar = parsed({ questionKind: "grammar_fill", answerMode: "gap_fill", sourceText: "They (1) ___ early.", passage: [{ partType: "text", textValue: "They (1) " }, { partType: "blank", questionId: "x" }, { partType: "text", textValue: " early." }] });
  expect(sourceFidelityViolations([grammar])[0]).toContain("whole printed gap marker");
});
it("keeps complete unsolved equations and options out of the stem", () => {
  expect(ocrPageViolations([parsed({ stem: "$6 \\times 7 = $ ____.", answerMode: "fill_blank" })], [], { text: "" })[0]).toContain("equation prefix");
  expect(ocrPageViolations([parsed({ stem: "6 × 7 = ____.", answerMode: "fill_blank" })], [], { text: "" })).toEqual([]);
  const q = parsed({ stem: "Which? A. First", answerMode: "choice", choiceVariant: "single", options: [{ label: "A", content: "First" }, { label: "B", content: "Second" }] });
  expect(ocrPageViolations([q], [], { text: "Which? A. First B. Second" })[0]).toContain("Keep the option in options");
});
it("retains explicit one-to-one matching policy", () => {
  const q = parsed({ answerMode: "matching", stem: "Pair values (one-to-one)" }), evidence = { text: "Matching — Pair values (one-to-one)" };
  expect(sourceFidelityViolations([q], evidence)[0]).toContain("matchingVariant=one_to_one"); expect(sourceFidelityViolations([{ ...q, matchingVariant: "one_to_one" }], evidence)).toEqual([]);
});
it("validates a closed grammar parent and its exact hint without borrowing a context child", () => {
  const text = "Grammar fill: Finish the statement\nBirds (2) ____ south.\n2. Hint: fly", questions = [
    { id: "page:1:parent", questionKind: "grammar_fill", answerMode: "gap_fill", questionTypeId: "Grammar fill", stem: "Finish the statement", sourceText: text, passage: [{ partType: "text", textValue: "Birds " }, { partType: "blank", questionId: "page:1:2" }, { partType: "text", textValue: " south." }] },
    { id: "page:1:2", parentId: "page:1:parent", blankCount: 1, stem: "Hint: fly", answerMode: "fill_blank", questionTypeId: "fill_blank", answerPayload: { answers: ["fly"] }, sourceText: "2. Hint: fly" },
  ], context = { index: 0, expectedNodeCount: null, presence: null, ocr: { text } };
  expect(validateSourceFields({ questions }, context).questions).toHaveLength(2);
  expect(() => validateSourceFields({ questions: [questions[0], { ...questions[1], stem: "Birds ____ south." }] }, context)).toThrow();
  expect(() => validateSourceFields({ questions: [questions[0], { ...questions[1], id: "page:2:2" }] }, context)).toThrow();
});
