// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { blankQuestion, QuestionEditor } from "./QuestionEditor";
import type { Question } from "./api";

HTMLElement.prototype.scrollIntoView = () => {};
afterEach(cleanup);

it("adds an unused choice label after deleting a middle option without renumbering existing labels", async () => {
  const save = vi.fn();
  render(<QuestionEditor initial={{ ...blankQuestion(), options: [{label:" a ",content:"One"}, {label:"B",content:"Two"}, {label:"C",content:"Three"}] }} busy={false} onClose={vi.fn()} onSave={save} />);
  await userEvent.click(screen.getAllByRole("button", {name:"删除"})[1]);
  await userEvent.click(screen.getByRole("button", {name:"增加选项"}));
  await userEvent.click(screen.getByRole("button", {name:"保存题目"}));
  expect(save.mock.calls[0][0].options.map((option: {label:string}) => option.label)).toEqual([" a ", "C", "B"]);
});

it("edits choice content and source evidence without mutating the original question", async () => {
  const user = userEvent.setup();
  const initial = { ...blankQuestion(), id: "choice", stem: "Old stem", options: [{ label: "A", content: "One" }, { label: "B", content: "Two" }], answerPayload: { correct: ["A"] } };
  const save = vi.fn();
  render(<QuestionEditor initial={initial} busy={false} onClose={vi.fn()} onSave={save} />);

  await user.clear(screen.getByRole("textbox", { name: "题干（支持 Markdown 和公式）" }));
  await user.type(screen.getByRole("textbox", { name: "题干（支持 Markdown 和公式）" }), "New stem");
  await user.click(screen.getByRole("button", { name: "增加选项" }));
  await user.type(screen.getByRole("textbox", { name: "选项 3 内容" }), "Three");
  await user.click(screen.getAllByRole("button", { name: "删除" })[1]);
  await user.type(screen.getByRole("spinbutton", { name: "原卷分值（没有则留空）" }), "2.5");
  await user.type(screen.getByRole("textbox", { name: "原文评分细则" }), "每题 2.5 分");
  await user.type(screen.getByRole("textbox", { name: "分值与细则的原文依据" }), "卷面标注");
  await user.click(screen.getByRole("button", { name: "保存题目" }));

  const edited = save.mock.calls[0][0];
  expect(edited).toMatchObject({ stem: "New stem", options: [{ label: "A", content: "One" }, { label: "C", content: "Three" }], answerPayload: null, sourceScore: 2.5, scoringRubric: "每题 2.5 分", scoreSourceText: "卷面标注" });
  expect(save.mock.calls[0][1]).toEqual([]);
  expect(initial.stem).toBe("Old stem");
  expect(initial.options).toHaveLength(2);
});

it("keeps matching item IDs on their own side when adding and removing items", async () => {
  const user = userEvent.setup();
  const initial = { ...blankQuestion(), id: "matching", answerMode: "matching" as const, choiceVariant: null, matchingVariant: "one_to_one" as const, options: [], items: [
    { id: 0, side: "left" as const, content: "L0" }, { id: 1, side: "left" as const, content: "L1" },
    { id: 0, side: "right" as const, content: "R0" }, { id: 1, side: "right" as const, content: "R1" },
  ] };
  const save = vi.fn();
  render(<QuestionEditor initial={initial} busy={false} onClose={vi.fn()} onSave={save} />);

  await user.click(screen.getByRole("button", { name: "增加左侧题项" }));
  await user.type(screen.getByRole("textbox", { name: "题项 5" }), "L2");
  await user.click(screen.getByRole("button", { name: "增加右侧题项" }));
  await user.type(screen.getByRole("textbox", { name: "题项 6" }), "R2");
  await user.click(screen.getAllByRole("button", { name: "删除" })[1]);
  await user.click(screen.getByRole("button", { name: "保存题目" }));

  expect(save.mock.calls[0][0].items).toEqual([
    { id: 0, side: "left", content: "L0" },
    { id: 0, side: "right", content: "R0" },
    { id: 1, side: "right", content: "R1" },
    { id: 2, side: "left", content: "L2" },
    { id: 2, side: "right", content: "R2" },
  ]);
  expect(initial.items).toHaveLength(4);
});

it("adds and removes a word-bank child together with its passage blank", async () => {
  const user = userEvent.setup();
  const root = { ...blankQuestion(), id: "word-root", answerMode: "word_bank" as const, choiceVariant: null, options: [{ label: "A", content: "spring" }, { label: "B", content: "winter" }] };
  const save = vi.fn();
  render(<QuestionEditor initial={root} busy={false} onClose={vi.fn()} onSave={save} />);

  await user.click(screen.getByRole("button", { name: "增加文章段落" }));
  await user.type(screen.getByRole("textbox", { name: "文章段落" }), "A season arrives.");
  await user.click(screen.getByRole("button", { name: "增加子题" }));
  const childStem = screen.getByRole("textbox", { name: "题干（支持 Markdown 和公式）" });
  await user.clear(childStem);
  await user.type(childStem, "Choose a season");
  await user.click(screen.getByRole("button", { name: "保存题目" }));
  await user.click(screen.getByRole("button", { name: "保存题目" }));

  const [editedRoot, children] = save.mock.calls[0];
  expect(children).toHaveLength(1);
  expect(children[0]).toMatchObject({ parentId: "word-root", optionSourceId: "word-root", options: [], stem: "Choose a season" });
  expect(editedRoot.passage).toMatchObject([{ partType: "text", textValue: "A season arrives." }, { partType: "blank", questionId: children[0].id }]);

  const childRow = screen.getByText("1. Choose a season").parentElement!;
  await user.click(within(childRow).getByRole("button", { name: "删除" }));
  await user.click(screen.getByRole("button", { name: "保存题目" }));
  expect(save.mock.calls[1][1]).toEqual([]);
  expect(save.mock.calls[1][0].passage).toMatchObject([{ partType: "text", textValue: "A season arrives." }]);
});

it("clears incompatible children and answer data when the answer mode changes", async () => {
  const user = userEvent.setup();
  const initial = { ...blankQuestion(), id: "reading-root", answerMode: "reading" as const, choiceVariant: null, options: [], passage: [{ partType: "text" as const, textValue: "Shared passage" }] };
  const child = { ...blankQuestion(), id: "child", parentId: "reading-root", stem: "Old child" };
  const save = vi.fn();
  render(<QuestionEditor initial={initial} initialChildren={[child]} busy={false} onClose={vi.fn()} onSave={save} />);

  await user.selectOptions(screen.getByRole("combobox", { name: "答题方式" }), "ordering");
  expect(screen.queryByText("Old child")).toBeNull();
  expect(screen.getAllByRole("textbox", { name: /题项 \d/ })).toHaveLength(2);
  await user.click(screen.getByRole("button", { name: "保存题目" }));

  const [edited, children] = save.mock.calls[0];
  expect(edited).toMatchObject({ answerMode: "ordering", passage: [], answerPayload: null });
  expect(edited.items).toHaveLength(2);
  expect(children).toEqual([]);
});

it("keeps an unknown answer mode empty until selected and disables editing while busy", async () => {
  const user = userEvent.setup();
  const initial = { ...blankQuestion(), answerMode: null };
  const save = vi.fn();
  const view = render(<QuestionEditor initial={initial} busy={false} onClose={vi.fn()} onSave={save} />);
  const mode = screen.getByRole("combobox", { name: "答题方式" }) as HTMLSelectElement;
  expect(mode.value).toBe("");
  await user.click(screen.getByRole("button", { name: "保存题目" }));
  expect(save.mock.calls[0][0].answerMode).toBeNull();
  view.rerender(<QuestionEditor initial={initial} busy onClose={vi.fn()} onSave={save} />);
  await user.selectOptions(mode, "ordering");
  expect(mode.value).toBe("");
});

it("protects changed question drafts on Escape and closes reverted drafts immediately", async () => {
  const user = userEvent.setup();
  const initial = { ...blankQuestion(), stem: "Original stem" };
  const close = vi.fn();
  render(<QuestionEditor initial={initial} busy={false} onClose={close} onSave={vi.fn()} />);
  const stem = screen.getByRole("textbox", { name: "题干（支持 Markdown 和公式）" });
  await user.clear(stem);
  await user.type(stem, "Changed stem");
  await user.keyboard("{Escape}");
  expect(close).not.toHaveBeenCalled();
  const confirmation = screen.getByRole("alertdialog", { name: "放弃未保存的更改？" });
  await user.click(within(confirmation).getByRole("button", { name: "继续编辑" }));
  expect((stem as HTMLTextAreaElement).value).toBe("Changed stem");
  expect(document.activeElement).toBe(stem);
  await user.clear(stem);
  await user.type(stem, "Original stem");
  await user.keyboard("{Escape}");
  expect(close).toHaveBeenCalledOnce();
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

const emptyReferenceCases = [
  { answerMode: "short_answer", choiceVariant: null, options: [], blankCount: null, control: "text", payload: { text: "" } },
  { answerMode: "choice", choiceVariant: "multiple", options: [{ label: "A", content: "One" }, { label: "B", content: "Two" }], blankCount: null, control: "choice", payload: { correct: [] } },
  { answerMode: "fill_blank", choiceVariant: null, options: [], blankCount: 2, control: "blank", payload: { answers: ["", ""] } },
] as const;
function referenceQuestion(scenario: typeof emptyReferenceCases[number]): Question {
  return { ...blankQuestion(), answerMode: scenario.answerMode, choiceVariant: scenario.choiceVariant, options: [...scenario.options], blankCount: scenario.blankCount };
}
async function revertReference(user: ReturnType<typeof userEvent.setup>, control: string) {
  if (control === "choice") {
    const choice = screen.getByRole("checkbox", { name: /A\. One/ });
    await user.click(choice);
    await user.click(choice);
  } else {
    const text = screen.getByRole("textbox", { name: control === "text" ? "作答内容" : "第 1 空" });
    await user.type(text, "Temporary reference");
    await user.clear(text);
  }
}
it.each(emptyReferenceCases)("closes reverted null $answerMode references through every dismissal and preserves raw saved payloads", async scenario => {
  const initial: Question = { ...referenceQuestion(scenario), answerPayload: null, needsReview: true, missingFields: ["answerPayload"] };
  for (const action of ["Escape", "close", "outside"]) {
    const user = userEvent.setup(), close = vi.fn(), save = vi.fn();
    render(<QuestionEditor initial={initial} busy={false} onClose={close} onSave={save} />);
    await revertReference(user, scenario.control);
    if (action === "Escape") await user.keyboard("{Escape}");
    else if (action === "close") await user.click(screen.getByRole("button", { name: "关闭" }));
    else await user.click(document.querySelector("[data-slot=dialog-overlay]")!);
    expect(close).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "保存题目" }));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ answerPayload: scenario.payload, needsReview: true, missingFields: ["answerPayload"] }), []);
    expect(initial.answerPayload).toBeNull();
    cleanup();
  }
});

const fallbackReferenceCases: { name: string; question: Question }[] = [
  { name: "new single choice", question: blankQuestion() },
  { name: "unknown mode", question: { ...blankQuestion(), answerMode: null } },
  { name: "missing choice variant", question: { ...blankQuestion(), choiceVariant: null, options: [{ label: "A", content: "One" }, { label: "B", content: "Two" }] } },
  { name: "incomplete ordering", question: { ...blankQuestion(), answerMode: "ordering", choiceVariant: null, items: [{ id: 0, content: "First" }, { id: 1, content: "" }] } },
  { name: "duplicate ordering IDs", question: { ...blankQuestion(), answerMode: "ordering", choiceVariant: null, items: [{ id: 0, content: "First" }, { id: 0, content: "Second" }] } },
  { name: "incomplete matching", question: { ...blankQuestion(), answerMode: "matching", choiceVariant: null, matchingVariant: "one_to_one", items: [{ id: 0, side: "left", content: "Left" }, { id: 0, side: "right", content: "Right" }] } },
];
it.each(fallbackReferenceCases)("closes reverted $name fallback references and preserves raw saves", async scenario => {
  for (const action of ["Escape", "close", "outside"]) {
    const user = userEvent.setup(), close = vi.fn(), save = vi.fn();
    const initial: Question = { ...scenario.question, answerPayload: null, needsReview: true, missingFields: ["answerPayload"] };
    render(<QuestionEditor initial={initial} busy={false} onClose={close} onSave={save} />);
    const text = screen.getByRole("textbox", { name: "自由作答" });
    await user.type(text, "Temporary reference");
    await user.clear(text);
    if (action === "Escape") await user.keyboard("{Escape}");
    else if (action === "close") await user.click(screen.getByRole("button", { name: "关闭" }));
    else await user.click(document.querySelector("[data-slot=dialog-overlay]")!);
    expect(close).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "保存题目" }));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ answerPayload: { text: "" }, needsReview: true, missingFields: ["answerPayload"] }), []);
    expect(initial.answerPayload).toBeNull();
    cleanup();
  }
});

it("keeps changed fallback text, other fields and removed payload evidence dirty", async () => {
  for (const payload of [null, { text: "Original reference" }, { text: " " }, { value: false }, { order: [0] }, { correct: [] }, { text: "", metadata: { count: 0, flag: false } }]) {
    const user = userEvent.setup(), close = vi.fn(), save = vi.fn();
    render(<QuestionEditor initial={{ ...blankQuestion(), choiceVariant: payload && "correct" in payload ? "multiple" : "single", answerPayload: payload as Question["answerPayload"] }} busy={false} onClose={close} onSave={save} />);
    const text = screen.getByRole("textbox", { name: "自由作答" });
    await user.type(text, "Changed reference");
    if (payload !== null) await user.clear(text);
    await user.keyboard("{Escape}");
    expect(close).not.toHaveBeenCalled();
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "继续编辑" }));
    await user.click(screen.getByRole("button", { name: "保存题目" }));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ answerPayload: { text: payload === null ? "Changed reference" : "" } }), []);
    cleanup();
  }
  const user = userEvent.setup(), close = vi.fn();
  render(<QuestionEditor initial={blankQuestion()} busy={false} onClose={close} onSave={vi.fn()} />);
  const text = screen.getByRole("textbox", { name: "自由作答" });
  await user.type(text, "Temporary reference");
  await user.clear(text);
  await user.type(screen.getByRole("textbox", { name: "题干（支持 Markdown 和公式）" }), "Actual change");
  await user.keyboard("{Escape}");
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByRole("alertdialog")).toBeTruthy();
});

it("does not stage a reverted shared-option fallback child as a parent edit", async () => {
  const user = userEvent.setup(), close = vi.fn(), save = vi.fn();
  const root: Question = { ...blankQuestion(), id: "root", answerMode: "word_bank", choiceVariant: null, options: [] };
  const child: Question = { ...blankQuestion(), id: "child", parentId: "root", optionSourceId: "root", stem: "Shared child", options: [{ label: "A", content: "Own one" }, { label: "B", content: "Own two" }] };
  render(<QuestionEditor initial={root} initialChildren={[child]} busy={false} onClose={close} onSave={save} />);
  await user.click(screen.getByRole("button", { name: "编辑题目" }));
  const text = screen.getByRole("textbox", { name: "自由作答" });
  await user.type(text, "Temporary reference");
  await user.clear(text);
  await user.click(screen.getByRole("button", { name: "保存题目" }));
  await user.keyboard("{Escape}");
  expect(close).toHaveBeenCalledOnce();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  await user.click(screen.getByRole("button", { name: "保存题目" }));
  expect(save).toHaveBeenCalledWith(root, [child]);
});

it("keeps empty text evidence distinct when shared options render an interactive choice", async () => {
  const user = userEvent.setup(), close = vi.fn(), save = vi.fn();
  const parent: Question = { ...blankQuestion(), id: "root", answerMode: "word_bank", options: [{ label: "A", content: "One" }, { label: "B", content: "Two" }] };
  const initial: Question = { ...blankQuestion(), parentId: "root", optionSourceId: "root", options: [], answerPayload: { text: "" } };
  render(<QuestionEditor initial={initial} parent={parent} busy={false} onClose={close} onSave={save} />);
  expect(screen.queryByRole("textbox", { name: "自由作答" })).toBeNull();
  expect(screen.getAllByRole("radio")).toHaveLength(2);
  await user.click(screen.getByRole("button", { name: "清空参考答案" }));
  await user.keyboard("{Escape}");
  expect(close).not.toHaveBeenCalled();
  await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "继续编辑" }));
  await user.click(screen.getByRole("button", { name: "保存题目" }));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ answerPayload: null }), []);
  expect(initial.answerPayload).toEqual({ text: "" });
});

it("preserves reference payloads hidden by composite editors", async () => {
  const save = vi.fn();
  const initial: Question = { ...blankQuestion(), answerMode: "reading", answerPayload: { text: "", metadata: { count: 0, flag: false } } as Question["answerPayload"] };
  render(<QuestionEditor initial={initial} busy={false} onClose={vi.fn()} onSave={save} />);
  expect(screen.queryByRole("textbox", { name: "自由作答" })).toBeNull();
  expect(screen.queryByRole("button", { name: "清空参考答案" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "保存题目" }));
  expect(save).toHaveBeenCalledWith(initial, []);
});

it.each(emptyReferenceCases)("keeps real edits dirty after reverting $answerMode reference controls", async scenario => {
  const user = userEvent.setup(), close = vi.fn(), save = vi.fn();
  render(<QuestionEditor initial={{ ...referenceQuestion(scenario), answerPayload: null }} busy={false} onClose={close} onSave={save} />);
  await revertReference(user, scenario.control);
  await user.type(screen.getByRole("textbox", { name: "题干（支持 Markdown 和公式）" }), "Actual change");
  await user.keyboard("{Escape}");
  expect(close).not.toHaveBeenCalled();
  await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "继续编辑" }));
  await user.click(screen.getByRole("button", { name: "保存题目" }));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ stem: "Actual change", answerPayload: scenario.payload }), []);
});

it("protects clearing actual reference evidence including false and extra metadata", async () => {
  for (const initial of [
    { ...blankQuestion(), answerMode: "short_answer" as const, answerPayload: { text: "Original reference" } },
    { ...blankQuestion(), answerMode: "short_answer" as const, answerPayload: { text: " " } },
    { ...blankQuestion(), choiceVariant: "multiple" as const, answerPayload: { correct: ["A"] } },
    { ...blankQuestion(), answerMode: "fill_blank" as const, blankCount: 2, answerPayload: { answers: ["", "Provided"] } },
    { ...blankQuestion(), answerMode: "true_false" as const, answerPayload: { value: false } },
    { ...blankQuestion(), answerMode: "short_answer" as const, answerPayload: { text: "", metadata: { missing: null } } as Question["answerPayload"] },
  ]) {
    const user = userEvent.setup(), close = vi.fn();
    render(<QuestionEditor initial={initial} busy={false} onClose={close} onSave={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "清空参考答案" }));
    await user.keyboard("{Escape}");
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).not.toBeNull();
    cleanup();
  }
});

it("keeps added empty answer slots and explicit ordering references dirty", async () => {
  for (const scenario of [
    { question: { ...blankQuestion(), answerMode: "fill_blank" as const, blankCount: null }, action: "增加一空" },
    { question: { ...blankQuestion(), answerMode: "ordering" as const, items: [{ id: 0, content: "First" }, { id: 1, content: "Second" }] }, action: "确认当前顺序" },
  ]) {
    const user = userEvent.setup(), close = vi.fn();
    render(<QuestionEditor initial={scenario.question} busy={false} onClose={close} onSave={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: scenario.action }));
    await user.keyboard("{Escape}");
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).not.toBeNull();
    cleanup();
  }
});

it("does not stage a reverted empty child reference as a parent change", async () => {
  const user = userEvent.setup(), close = vi.fn(), save = vi.fn();
  const root: Question = { ...blankQuestion(), id: "root", answerMode: "reading", choiceVariant: null, options: [] };
  const child: Question = { ...referenceQuestion(emptyReferenceCases[0]), id: "child", parentId: "root", answerPayload: null };
  render(<QuestionEditor initial={root} initialChildren={[child]} busy={false} onClose={close} onSave={save} />);
  await user.click(screen.getByRole("button", { name: "编辑题目" }));
  await revertReference(user, "text");
  await user.click(screen.getByRole("button", { name: "保存题目" }));
  await user.keyboard("{Escape}");
  expect(close).toHaveBeenCalledOnce();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  await user.click(screen.getByRole("button", { name: "保存题目" }));
  expect(save).toHaveBeenCalledWith(root, [child]);
});

it.each(["Escape", "close", "discard"])("closes an unchanged question immediately through %s", async action => {
  const user = userEvent.setup();
  const close = vi.fn();
  render(<QuestionEditor initial={{ ...blankQuestion(), id: null }} busy={false} onClose={close} onSave={vi.fn()} />);
  if (action === "Escape") await user.keyboard("{Escape}");
  else await user.click(screen.getByRole("button", { name: action === "close" ? "关闭" : "放弃更改" }));
  expect(close).toHaveBeenCalledOnce();
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it.each([
  ["textbox", "作答说明", "Draft instructions"],
  ["spinbutton", "原卷分值（没有则留空）", "2.5"],
  ["textbox", "原文评分细则", "Draft rubric"],
  ["textbox", "分值与细则的原文依据", "Draft source"],
] as const)("closes a new question after reverting omitted %s field %s", async (role, name, draft) => {
  const user = userEvent.setup();
  const initial = blankQuestion();
  const close = vi.fn(), save = vi.fn();
  render(<QuestionEditor initial={initial} busy={false} onClose={close} onSave={save} />);
  const field = screen.getByRole(role, { name });
  await user.type(field, draft);
  await user.clear(field);
  await user.keyboard("{Escape}");
  expect(close).toHaveBeenCalledOnce();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(save).not.toHaveBeenCalled();
  expect(initial).not.toHaveProperty("instructions");
});

it("keeps other edits dirty after reverting instructions and saves explicit null", async () => {
  const user = userEvent.setup();
  const close = vi.fn(), save = vi.fn();
  render(<QuestionEditor initial={blankQuestion()} busy={false} onClose={close} onSave={save} />);
  const instructions = screen.getByRole("textbox", { name: "作答说明" });
  await user.type(instructions, "Temporary instructions");
  await user.clear(instructions);
  await user.type(screen.getByRole("textbox", { name: "题干（支持 Markdown 和公式）" }), "Actual change");
  await user.keyboard("{Escape}");
  expect(close).not.toHaveBeenCalled();
  await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "继续编辑" }));
  await user.click(screen.getByRole("button", { name: "保存题目" }));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ stem: "Actual change", instructions: null }), []);
});

it("protects clearing existing instructions and preserves null when saving", async () => {
  const user = userEvent.setup();
  const initial = { ...blankQuestion(), instructions: "Original instructions" };
  const close = vi.fn(), save = vi.fn();
  render(<QuestionEditor initial={initial} busy={false} onClose={close} onSave={save} />);
  await user.clear(screen.getByRole("textbox", { name: "作答说明" }));
  await user.keyboard("{Escape}");
  expect(close).not.toHaveBeenCalled();
  await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "继续编辑" }));
  await user.click(screen.getByRole("button", { name: "保存题目" }));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ instructions: null }), []);
  expect(initial.instructions).toBe("Original instructions");
});

it.each([
  ["stem", "题干（支持 Markdown 和公式）"],
  ["questionTypeId", "题型名称"],
] as const)("closes a reverted nullable %s without changing saved missing evidence", async (key, name) => {
  const user = userEvent.setup();
  const initial: Question = { ...blankQuestion(), [key]: null, needsReview: true, missingFields: [key] };
  const close = vi.fn(), save = vi.fn();
  render(<QuestionEditor initial={initial} busy={false} onClose={close} onSave={save} />);
  const field = screen.getByRole("textbox", { name });
  await user.type(field, "Temporary text");
  await user.clear(field);
  await user.keyboard("{Escape}");
  expect(close).toHaveBeenCalledOnce();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  await user.click(screen.getByRole("button", { name: "保存题目" }));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ [key]: "", needsReview: true, missingFields: [key] }), []);
  expect(initial[key]).toBeNull();
});

it.each(["passage", "contentBlocks"] as const)("closes reverted %s block edits while preserving roles and JSON content", async field => {
  const user = userEvent.setup();
  const jsonValue = { label: null, textValue: null, rows: [{ value: null }] };
  const initial: Question = { ...blankQuestion(), answerMode: field === "passage" ? "reading" : "short_answer", questionKind: field === "passage" ? "reading" : "writing", choiceVariant: null, options: [], [field]: [{ partType: "text", role: "material", textValue: "Original text", jsonValue }] };
  const close = vi.fn(), save = vi.fn();
  render(<QuestionEditor initial={initial} busy={false} onClose={close} onSave={save} />);
  const label = screen.getByRole("textbox", { name: field === "passage" ? "段落标签" : "材料段落标签" });
  const text = screen.getByRole("textbox", { name: field === "passage" ? "文章段落" : "材料内容" });
  await user.type(label, "Temporary label");
  await user.clear(label);
  await user.clear(text);
  await user.type(text, "Original text");
  await user.keyboard("{Escape}");
  expect(close).toHaveBeenCalledOnce();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  await user.click(screen.getByRole("button", { name: "保存题目" }));
  expect(save.mock.calls[0][0][field]).toEqual([{ ...initial[field]![0], label: null, markdownValue: null, ...(field === "passage" ? { latexValue: null } : {}) }]);
  expect(save.mock.calls[0][0][field][0].jsonValue).toEqual(jsonValue);
  expect(initial[field]![0]).not.toHaveProperty("label");
  close.mockClear();
  save.mockClear();
  await user.type(label, "Changed label");
  await user.type(text, " changed");
  await user.keyboard("{Escape}");
  expect(close).not.toHaveBeenCalled();
  await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "继续编辑" }));
  await user.click(screen.getByRole("button", { name: "保存题目" }));
  expect(save.mock.calls[0][0][field]).toEqual([{ ...initial[field]![0], label: "Changed label", textValue: "Original text changed", markdownValue: null, ...(field === "passage" ? { latexValue: null } : {}) }]);
});

it.each(["options", "items"] as const)("closes reverted nullable %s labels and content", async field => {
  const user = userEvent.setup();
  const initial: Question = { ...blankQuestion(), answerMode: field === "options" ? "choice" : "ordering", [field]: field === "options" ? [{ label: null, content: null }, { label: "B", content: "Two" }] : [{ id: 0, content: null }] };
  const close = vi.fn();
  render(<QuestionEditor initial={initial} busy={false} onClose={close} onSave={vi.fn()} />);
  for (const name of field === "options" ? ["选项 1 标签", "选项 1 内容"] : ["段落标签", "题项 1"]) {
    const input = screen.getByRole("textbox", { name });
    await user.type(input, "Temporary text");
    await user.clear(input);
  }
  await user.keyboard("{Escape}");
  expect(close).toHaveBeenCalledOnce();
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("keeps changed nested content and transcript removal dirty", async () => {
  const user = userEvent.setup();
  const initial: Question = { ...blankQuestion(), answerMode: "listening", questionKind: "listening", choiceVariant: null, options: [], transcript: [{ partType: "text", role: "material", textValue: "Original transcript", jsonValue: { note: null } }] };
  const close = vi.fn(), save = vi.fn();
  render(<QuestionEditor initial={initial} busy={false} onClose={close} onSave={save} />);
  await user.clear(screen.getByRole("textbox", { name: "听力原文" }));
  await user.keyboard("{Escape}");
  expect(close).not.toHaveBeenCalled();
  await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "继续编辑" }));
  await user.click(screen.getByRole("button", { name: "保存题目" }));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ transcript: [] }), []);
  expect(initial.transcript).toHaveLength(1);
});

it("closes reverted listening defaults without changing the saved shape", async () => {
  const user = userEvent.setup();
  const initial: Question = { ...blankQuestion(), answerMode: "listening", questionKind: "listening", choiceVariant: null, options: [] };
  const close = vi.fn(), save = vi.fn();
  render(<QuestionEditor initial={initial} busy={false} onClose={close} onSave={save} />);
  for (const [name, original] of [["开始秒数", "0"], ["考试播放次数", "2"]]) {
    const field = screen.getByRole("spinbutton", { name });
    await user.clear(field);
    await user.type(field, "3");
    await user.clear(field);
    await user.type(field, original);
  }
  const transcript = screen.getByRole("textbox", { name: "听力原文" });
  await user.type(transcript, "Temporary transcript");
  await user.clear(transcript);
  await user.keyboard("{Escape}");
  expect(close).toHaveBeenCalledOnce();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  await user.click(screen.getByRole("button", { name: "保存题目" }));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ audioStartSeconds: 0, examPlayCount: 2, transcript: [] }), []);
  expect(initial).not.toHaveProperty("transcript");
});

it("closes a restored transcript with declared outer null defaults", async () => {
  const user = userEvent.setup();
  const initial: Question = { ...blankQuestion(), answerMode: "listening", questionKind: "listening", choiceVariant: null, options: [], transcript: [{ partType: "text", label: null, role: null, questionId: null, textValue: "Original transcript", markdownValue: null, latexValue: null, jsonValue: null }] };
  const close = vi.fn(), save = vi.fn();
  render(<QuestionEditor initial={initial} busy={false} onClose={close} onSave={save} />);
  const transcript = screen.getByRole("textbox", { name: "听力原文" });
  await user.clear(transcript);
  await user.type(transcript, "Original transcript");
  await user.keyboard("{Escape}");
  expect(close).toHaveBeenCalledOnce();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  await user.click(screen.getByRole("button", { name: "保存题目" }));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ transcript: [{ partType: "text", textValue: "Original transcript" }] }), []);
  expect(initial.transcript![0]).toHaveProperty("jsonValue", null);
});

it("protects a changed question on X and lets explicit discard close directly", async () => {
  const user = userEvent.setup();
  const close = vi.fn(), save = vi.fn();
  render(<QuestionEditor initial={blankQuestion()} busy={false} onClose={close} onSave={save} />);
  await user.type(screen.getByRole("textbox", { name: "解析" }), "Draft analysis");
  await user.click(screen.getByRole("button", { name: "关闭" }));
  expect(close).not.toHaveBeenCalled();
  await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "继续编辑" }));
  await user.click(screen.getByRole("button", { name: "放弃更改" }));
  expect(close).toHaveBeenCalledOnce();
  expect(save).not.toHaveBeenCalled();
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("protects saved descendant drafts at every ancestor and saves the complete edited tree", async () => {
  const user = userEvent.setup();
  const root = { ...blankQuestion(), id: "root", answerMode: "reading" as const, choiceVariant: null, options: [], stem: "Shared material" };
  const child = { ...blankQuestion(), id: "child", parentId: "root", answerMode: "cloze" as const, choiceVariant: null, options: [], stem: "Cloze material" };
  const leaf = { ...blankQuestion(), id: "leaf", parentId: "child", stem: "Original leaf" };
  const close = vi.fn(), save = vi.fn();
  render(<QuestionEditor initial={root} initialChildren={[child, leaf]} busy={false} onClose={close} onSave={save} />);
  await user.click(screen.getByRole("button", { name: "编辑题目" }));
  await user.click(screen.getByRole("button", { name: "编辑题目" }));
  const leafStem = screen.getByRole("textbox", { name: "题干（支持 Markdown 和公式）" });
  await user.clear(leafStem);
  await user.type(leafStem, "Edited leaf");
  await user.keyboard("{Escape}");
  await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "继续编辑" }));
  expect((leafStem as HTMLTextAreaElement).value).toBe("Edited leaf");
  await user.click(screen.getByRole("button", { name: "保存题目" }));
  await user.click(screen.getByRole("button", { name: "关闭" }));
  await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "继续编辑" }));
  expect(screen.getByText("1. Edited leaf")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "保存题目" }));
  await user.keyboard("{Escape}");
  expect(close).not.toHaveBeenCalled();
  await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "继续编辑" }));
  await user.click(screen.getByRole("button", { name: "保存题目" }));
  expect(save).toHaveBeenCalledWith(root, [expect.objectContaining({ id: "child", parentId: "root" }), expect.objectContaining({ id: "leaf", parentId: "child", stem: "Edited leaf" })]);
  expect(leaf.stem).toBe("Original leaf");
});

it("discards a changed child without changing the parent's tree or dirty state", async () => {
  const user = userEvent.setup();
  const root = { ...blankQuestion(), id: "root", answerMode: "reading" as const, choiceVariant: null, options: [] };
  const child = { ...blankQuestion(), id: "child", parentId: "root", stem: "Original child" };
  const close = vi.fn(), save = vi.fn();
  render(<QuestionEditor initial={root} initialChildren={[child]} busy={false} onClose={close} onSave={save} />);
  await user.click(screen.getByRole("button", { name: "编辑题目" }));
  await user.type(screen.getByRole("textbox", { name: "题干（支持 Markdown 和公式）" }), " discarded");
  await user.keyboard("{Escape}");
  await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "放弃更改" }));
  expect(screen.getByText("1. Original child")).toBeTruthy();
  await user.keyboard("{Escape}");
  expect(close).toHaveBeenCalledOnce();
  expect(save).not.toHaveBeenCalled();
});

function childBeforeParentTree() {
  const root = { ...blankQuestion(), id: "root", answerMode: "reading" as const, choiceVariant: null, options: [], stem: "Shared material" };
  const child = { ...blankQuestion(), id: "child", parentId: "root", answerMode: "cloze" as const, choiceVariant: null, options: [], stem: "Cloze material", passage: [{ partType: "blank" as const, questionId: "leaf" }] };
  const leaf = { ...blankQuestion(), id: "leaf", parentId: "child", stem: "Nested leaf" };
  const sibling = { ...blankQuestion(), id: "sibling", parentId: "root", stem: "Sibling question" };
  return { root, children: [leaf, child, sibling] };
}

it("does not dirty or reorder a child-before-parent imported tree when saving reverted instructions", async () => {
  const user = userEvent.setup();
  const { root, children } = childBeforeParentTree();
  const close = vi.fn(), save = vi.fn();
  render(<QuestionEditor initial={root} initialChildren={children} busy={false} onClose={close} onSave={save} />);
  await user.click(screen.getAllByRole("button", { name: "编辑题目" })[0]);
  const instructions = screen.getByRole("textbox", { name: "作答说明" });
  await user.type(instructions, "Temporary child instructions");
  await user.clear(instructions);
  await user.click(screen.getByRole("button", { name: "保存题目" }));
  await user.click(screen.getByRole("button", { name: "保存题目" }));
  expect(save).toHaveBeenCalledWith(root, children);
  await user.keyboard("{Escape}");
  expect(close).toHaveBeenCalledOnce();
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("preserves sibling order when saving a changed child whose descendant precedes it", async () => {
  const user = userEvent.setup();
  const { root, children } = childBeforeParentTree();
  const save = vi.fn();
  render(<QuestionEditor initial={root} initialChildren={children} busy={false} onClose={vi.fn()} onSave={save} />);
  await user.click(screen.getAllByRole("button", { name: "编辑题目" })[0]);
  const instructions = screen.getByRole("textbox", { name: "作答说明" });
  await user.type(instructions, "Temporary child instructions");
  await user.clear(instructions);
  await user.type(screen.getByRole("textbox", { name: "题干（支持 Markdown 和公式）" }), " changed");
  await user.click(screen.getByRole("button", { name: "保存题目" }));
  expect(screen.getByText("1. Cloze material changed")).toBeTruthy();
  expect(screen.getByText("2. Sibling question")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "保存题目" }));
  expect(save.mock.calls[0][1].map((question: { id: string }) => question.id)).toEqual(["child", "leaf", "sibling"]);
  expect(save.mock.calls[0][1][0]).toMatchObject({ stem: "Cloze material changed", instructions: null });
  expect(save.mock.calls[0][1].find((question: { id: string }) => question.id === "leaf")).toEqual(children[0]);
});
