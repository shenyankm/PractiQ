// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { blankQuestion, QuestionEditor } from "./QuestionEditor";

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

it.each(["Escape", "close", "discard"])("closes an unchanged question immediately through %s", async action => {
  const user = userEvent.setup();
  const close = vi.fn();
  render(<QuestionEditor initial={{ ...blankQuestion(), id: null }} busy={false} onClose={close} onSave={vi.fn()} />);
  if (action === "Escape") await user.keyboard("{Escape}");
  else await user.click(screen.getByRole("button", { name: action === "close" ? "关闭" : "放弃更改" }));
  expect(close).toHaveBeenCalledOnce();
  expect(screen.queryByRole("alertdialog")).toBeNull();
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

it("does not dirty or reorder a child-before-parent imported tree when saving an unchanged child", async () => {
  const user = userEvent.setup();
  const { root, children } = childBeforeParentTree();
  const close = vi.fn(), save = vi.fn();
  render(<QuestionEditor initial={root} initialChildren={children} busy={false} onClose={close} onSave={save} />);
  await user.click(screen.getAllByRole("button", { name: "编辑题目" })[0]);
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
  await user.type(screen.getByRole("textbox", { name: "题干（支持 Markdown 和公式）" }), " changed");
  await user.click(screen.getByRole("button", { name: "保存题目" }));
  expect(screen.getByText("1. Cloze material changed")).toBeTruthy();
  expect(screen.getByText("2. Sibling question")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "保存题目" }));
  expect(save.mock.calls[0][1].map((question: { id: string }) => question.id)).toEqual(["child", "leaf", "sibling"]);
  expect(save.mock.calls[0][1].find((question: { id: string }) => question.id === "leaf")).toEqual(children[0]);
});
