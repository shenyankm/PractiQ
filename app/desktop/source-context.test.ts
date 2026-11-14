import { expect, it } from "vitest";
import { sourceContext } from "./source-context.js";

const page = (text = "Material") => ({ elements: [{ text_info: { content: text } }], failed: false });
const document = (first: string, count = 8) => Array.from({ length: count }, (_, index) => page(index ? "Material" : first));

it("handles empty/missing evidence and retains bounded adjacent pages without mutation", () => {
  expect(sourceContext([])).toEqual([[], []]);
  expect(sourceContext([{}])).toEqual([[[0]], []]);
  const pages = document("Material", 6), before = structuredClone(pages), [plans, incomplete] = sourceContext(pages);
  expect(plans[0]).toEqual([0, 1]); expect(plans[3]).toEqual([1, 2, 3, 4]); expect(plans[5]).toEqual([3, 4, 5]);
  expect(incomplete).toEqual([]); expect(pages).toEqual(before);
});

it.each(["Answer key", "Answers", "Solutions", "答案", "参考答案与解析", "# Answers"])("links a uniquely owned question to a distant %s page", heading => {
  const pages = document("17. Printed question?"); pages[7] = page(`${heading}\n17. 4`);
  expect(sourceContext(pages)[0][0]).toEqual([0, 1, 7]);
});

it("does not associate an answer with ambiguous repeated source numbering", () => {
  const pages = document("17. First question?"); pages[3] = page("17. Different question?"); pages[7] = page("Answer key\n17. 4");
  expect(sourceContext(pages)[0][0]).toEqual([0, 1]);
});

it.each(["１７", "١٧"])("retains literal Unicode numbering when associating answers: %s", number => {
  const pages = document(`${number}. Prompt`); pages[7] = page(`答案\n${number}. Answer`);
  expect(sourceContext(pages)[0][0]).toEqual([0, 1, 7]);
});

it("does not mistake a decimal number or inline answer label for question/answer headings", () => {
  const pages = document("3.14 is a decimal value"); pages[7] = page("Answer key\n3. Answer");
  expect(sourceContext(pages)[0][0]).toEqual([0, 1]);
  pages[0] = page("17. Prompt"); pages[7] = page("This prose mentions Answers\n17. Other material");
  expect(sourceContext(pages)[0][0]).toEqual([0, 1]);
});

it.each(["See page 6", "refer to pages 5–6", "参见第5至6页", "见第５-６页"])("retains explicit source page references: %s", reference => {
  const [plans, incomplete] = sourceContext(document(reference, 6));
  expect(plans[0]).toContain(5); expect(plans[0]).toEqual([...new Set(plans[0])].sort((a, b) => a - b));
  expect(incomplete).toEqual([]);
});

it.each(["See page 0", "see pages 4-2", "参考第99页"])("marks an invalid reference incomplete instead of using arbitrary pages: %s", reference => {
  const [plans, incomplete] = sourceContext(document(reference, 6));
  expect(plans[0]).toEqual([0, 1]); expect(incomplete).toContain(0);
});

it("disables explicit references without losing independently proven answer links", () => {
  const pages = document("17. Prompt. See page 8"); pages[7] = page("Answers\n17. Answer");
  const [plans, incomplete] = sourceContext(pages, false);
  expect(plans[0]).toEqual([0, 1, 7]); expect(incomplete).toContain(0);
});

it.each([1, 3])("does not cross a failed page or use a failed destination: %i", failed => {
  const pages = document("See page 4", 5); pages[failed].failed = true;
  const [plans, incomplete] = sourceContext(pages);
  expect(plans[0]).not.toContain(3); expect(plans[failed]).toEqual([]); expect(incomplete).toContain(0);
});

it("does not read failed PRIMARY text or link to a failed first page", () => {
  const pages = document("Answers\n17. Unavailable answer", 4); pages[0].failed = true; pages[3] = page("17. Prompt. See page 1");
  const [plans, incomplete] = sourceContext(pages);
  expect(plans[0]).toEqual([]); expect(plans[3]).not.toContain(0); expect(incomplete).toContain(3);
});

it("caps a long page range at eight context pages and marks the plan incomplete", () => {
  const [plans, incomplete] = sourceContext(document("See pages 1-20", 20));
  expect(plans[0]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]); expect(incomplete).toContain(0);
});
