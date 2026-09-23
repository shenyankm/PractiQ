// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { blankQuestion, QuestionEditor } from "./QuestionEditor";

HTMLElement.prototype.scrollIntoView = () => {};
afterEach(cleanup);

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

  screen.getByRole("combobox").focus();
  await user.keyboard("{Enter}");
  await user.click(screen.getByRole("option", { name: "排序题" }));
  expect(screen.queryByText("Old child")).toBeNull();
  expect(screen.getAllByRole("textbox", { name: /题项 \d/ })).toHaveLength(2);
  await user.click(screen.getByRole("button", { name: "保存题目" }));

  const [edited, children] = save.mock.calls[0];
  expect(edited).toMatchObject({ answerMode: "ordering", passage: [], answerPayload: null });
  expect(edited.items).toHaveLength(2);
  expect(children).toEqual([]);
});
