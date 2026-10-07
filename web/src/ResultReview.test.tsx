import { createRequire } from "node:module";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import ResultReview, { ImageArtifact, Markdown } from "./ResultReview";
import { Client } from "./api";
import { material, preview, question, task } from "./test-fixtures";

it("keeps KaTeX CSS and every math renderer on the same version", () => {
  const require = createRequire(import.meta.url);
  const version = require("katex/package.json").version;
  for (const name of ["rehype-katex", "micromark-extension-math"]) {
    const renderer = createRequire(require.resolve(name));
    expect(renderer("katex/package.json").version).toBe(version);
  }
});

it("disables raw HTML, external links/images and trusted math extensions", () => {
  const { container } = render(<Markdown text={'<script>window.injected=true</script>\n\n![外图](https://untrusted.invalid/image.png) [链接](https://untrusted.invalid)\n\n$x^2$'} />);
  expect(container.querySelector("script,img,a")).toBeNull();
  expect(screen.getByText("[图片：外图]")).toBeTruthy();
  expect(container.querySelector(".katex")).toBeTruthy();
  const { container: missing } = render(<Markdown text={null} />);
  expect(missing.textContent).toBe("未提供（null）");
});
it("preserves null answers, material/shared options, source associations and partial warnings", async () => {
  const user = userEvent.setup();
  render(<ResultReview task={task} preview={preview} client={new Client("fake")} />);
  expect(screen.getByText(/这是部分结果/)).toBeTruthy();
  expect(screen.getByText("保留失败单元；参考答案缺失。")).toBeTruthy();
  await user.click(screen.getByText("根据材料选择答案"));
  expect(screen.getByText("未提供（null），不会补写答案")).toBeTruthy();
  expect(screen.getByText("共享选项一")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "所属材料 · q-material" })).toBeTruthy();
  expect(screen.getByText("原文包含题目，但未提供参考答案。")).toBeTruthy();
  await user.click(screen.getByText("完整结构化记录（只读）"));
  expect(screen.getByText(/"answerPayload": null/)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "来源与资源" }));
  expect(screen.getByText("阅读分组")).toBeTruthy();
  expect(screen.getAllByText(/"questionId": "q-child"/).length).toBeGreaterThan(0);
  expect(screen.getByText(/"unitIndex": 0/)).toBeTruthy();
});
it("shows HTML blocks as inert source text and retains missing stems/types", async () => {
  const user = userEvent.setup(); const { container } = render(<ResultReview task={task} preview={preview} client={new Client("fake")} />);
  await user.click(screen.getByText("题干未提供（null）"));
  expect(screen.getByText("<script>window.documentInjected=true</script>")).toBeTruthy();
  expect(container.querySelector("script")).toBeNull();
  expect(screen.getByText("题型未知（null）")).toBeTruthy();
});
it("paginates every question record without modifying the DTO, and supports result-only/empty previews", async () => {
  const user = userEvent.setup();
  const questions = Array.from({ length: 21 }, (_, index) => question({ id: `q-${index}`, parentId: null, optionSourceId: null, stem: `题目 ${index}` }));
  const before = JSON.stringify(questions);
  const { rerender } = render(<ResultReview task={task} preview={{ ...preview, units: [{ ...preview.units[0], questions }] }} client={new Client("fake")} />);
  expect(screen.queryByText("题目 20")).toBeNull();
  await user.click(screen.getByRole("button", { name: "下一页题目" }));
  expect(screen.getByText("题目 20")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "上一页题目" }));
  expect(screen.getByText("题目 0")).toBeTruthy();
  expect(JSON.stringify(questions)).toBe(before);
  rerender(<ResultReview task={task} preview={null} client={new Client("fake")} />);
  expect(screen.getByText("根据材料选择答案")).toBeTruthy();
  rerender(<ResultReview task={{ ...task, result: null, processing: null, status: null }} preview={null} client={new Client("fake")} />);
  expect(screen.getByText(/尚无可查看的题目/)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "来源与资源" }));
  expect(screen.getByText("无文档分组。")).toBeTruthy(); expect(screen.getByText("无关联图片。")).toBeTruthy();
});
it("renders structured formulas/blanks/items and only reads images on an explicit click", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const user = userEvent.setup(); const client = new Client("fake"); const image = vi.spyOn(client, "image").mockResolvedValue(new Blob(["image"], { type: "image/png" })); const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:checked-image"); const revoke = vi.spyOn(URL, "revokeObjectURL");
  const reference = { objectKey: "managed/image.png", sha256: "a".repeat(64), mediaType: "image/png", sizeBytes: 5 };
  const q = question({ parentId: null, optionSourceId: null, answerPayload: { text: "原文答案" }, analysis: "解析原文", scoringRubric: "文档评分依据", options: [{ label: null, content: null }], items: [{ id: 1, side: "left", content: "项目" }], contentBlocks: [{ partType: "formula", label: "公式", role: "question", latexValue: "x^2" }, { partType: "blank", questionId: "child" }, { partType: "text", textValue: "独立正文", jsonValue: { rows: [["a"]] } }] });
  const view = render(<ResultReview task={task} preview={{ ...preview, units: [{ ...preview.units[0], questions: [q], visualElements: [{ kind: "image", description: "受校验图片", imageRef: reference, sourceRef: reference, questionIndexes: [0] }], sourceRef: reference }] }} client={client} />);
  await user.click(screen.getByText("根据材料选择答案"));
  expect(screen.getByText("公式")).toBeTruthy(); expect(screen.getByText("空位 · child")).toBeTruthy(); expect(screen.getByText("项目")).toBeTruthy();
  expect(view.container.querySelector('annotation[encoding="application/x-tex"]')?.textContent).toBe("x^2");
  expect(view.container.querySelector(".katex-display")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "来源与资源" })); expect(image).not.toHaveBeenCalled();
  const figure = screen.getByText("受校验图片", { selector: "figcaption" }).closest("figure")!;
  await user.click(within(figure).getByRole("button", { name: "查看图片" }));
  expect(await within(figure).findByRole("img", { name: "受校验图片" })).toBeTruthy(); expect(create).toHaveBeenCalledTimes(1);
  const sourceFigure = screen.getByText("完整来源页", { selector: "figcaption" }).closest("figure")!;
  await user.click(within(sourceFigure).getByRole("button", { name: "查看图片" }));
  expect(await within(sourceFigure).findByRole("img", { name: "完整来源页" })).toBeTruthy(); expect(image).toHaveBeenCalledTimes(2);
  expect(errors).not.toHaveBeenCalled();
  view.unmount(); expect(revoke).toHaveBeenCalledWith("blob:checked-image");
});
it("does not leak an object URL if image loading completes after unmount, and allows a manual error retry", async () => {
  const user = userEvent.setup(); const client = new Client("fake"); const reference = { objectKey: "managed", sha256: "a".repeat(64), mediaType: "image/png", sizeBytes: 1 };
  let finish!: (blob: Blob) => void;
  vi.spyOn(client, "image").mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockRejectedValueOnce(new Error("failed")).mockResolvedValueOnce(new Blob(["x"]));
  const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:retry");
  const view = render(<ImageArtifact reference={reference} description="图片" client={client} />);
  await user.click(screen.getByRole("button", { name: "查看图片" })); view.unmount(); await act(async () => finish(new Blob(["x"]))); expect(create).not.toHaveBeenCalled();
  render(<ImageArtifact reference={reference} description="图片" client={client} />);
  await user.click(screen.getByRole("button", { name: "查看图片" })); expect(await screen.findByRole("alert")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "查看图片" })); expect(await screen.findByRole("img", { name: "图片" })).toBeTruthy();
});


it("paginates source resources and preserves unit-local duplicate question references",async()=>{
  const user = userEvent.setup();
  const units = [0,1].map(index=>({...preview.units[0],stage:"document_parse" as const,index,questions:[question({id:"owner",stem:`Owner ${index}`,parentId:null,optionSourceId:null}),question({id:`child${index}`,stem:`Child ${index}`,parentId:"owner",optionSourceId:null})],groups:Array.from({length:25},(_,i)=>({title:`Group ${index}-${i}`,questionIndexes:[0,1]})),visualElements:[]}));
  units[0].questions.unshift(question({id:JSON.stringify(["document_parse",1,"owner"]),stem:"Collision bait",parentId:null,optionSourceId:null}));
  render(<ResultReview task={task} preview={{...preview,units}} client={new Client("fake")}/>);
  await user.click(screen.getByText("Child 1"));
  const child = screen.getByText("Child 1",{selector:"summary span"}).closest("details")!;
  expect(within(child).getByText("Owner 1")).toBeTruthy(); expect(within(child).queryByText("Owner 0")).toBeNull();
  await user.click(screen.getByRole("button",{name:"来源与资源"}));
  expect(screen.getByText("Group 0-0")).toBeTruthy(); expect(screen.queryByText("Group 0-20")).toBeNull();
  await user.click(screen.getByRole("button",{name:"下一页资源"}));
  expect(screen.getByText("Group 0-20")).toBeTruthy(); expect(screen.queryByText("Group 0-0")).toBeNull();
  await user.click(screen.getByRole("button",{name:"上一页资源"})); expect(screen.getByText("Group 0-0")).toBeTruthy();
});

it("uses local duplicate owners and only unique cross-unit material and options", async () => {
  const user = userEvent.setup();
  const owners = [0, 1].map(index => ({ ...material, id: "owner", stem: `Material ${index}`, passage: [{ partType: "text" as const, textValue: `Passage ${index}` }], options: [{ label: "A", content: `Shared option ${index}` }] }));
  const unique = { ...material, id: "unique", stem: "Unique material", options: [{ label: "A", content: "Unique option" }] };
  const units = [
    [owners[0], unique, question({ id: "local-0", stem: "Local child 0", parentId: "owner", optionSourceId: "owner" })],
    [owners[1], question({ id: "local-1", stem: "Local child 1", parentId: "owner", optionSourceId: "owner" })],
    [question({ id: "unresolved", stem: "Unresolved child", parentId: "owner", optionSourceId: "owner", options: [{ label: "A", content: "Own unresolved option" }] }), question({ id: "unique-child", stem: "Unique child", parentId: "unique", optionSourceId: "unique" })],
  ].map((questions, index) => ({ ...preview.units[0], stage: "document_parse" as const, index, questions, groups: [] }));
  render(<ResultReview task={task} preview={{ ...preview, units, questionSources: [] }} client={new Client("fake")} />);
  for (const index of [0, 1]) {
    await user.click(screen.getByText(`Local child ${index}`));
    const child = within(screen.getByText(`Local child ${index}`, { selector: "summary span" }).closest("details")!);
    expect(child.getByText(`Material ${index}`)).toBeTruthy();
    expect(child.getByText(`Passage ${index}`)).toBeTruthy();
    expect(child.getByText(`Shared option ${index}`)).toBeTruthy();
    expect(child.queryByText(`Shared option ${1 - index}`)).toBeNull();
  }
  await user.click(screen.getByText("Unresolved child"));
  const unresolved = within(screen.getByText("Unresolved child", { selector: "summary span" }).closest("details")!);
  expect(unresolved.queryByRole("heading", { name: "所属材料 · owner" })).toBeNull();
  expect(unresolved.queryByRole("heading", { name: "共享选项 · owner" })).toBeNull();
  expect(unresolved.getByText("Own unresolved option")).toBeTruthy();
  await user.click(screen.getByText("Unique child"));
  const child = within(screen.getByText("Unique child", { selector: "summary span" }).closest("details")!);
  expect(child.getByText("Unique material")).toBeTruthy();
  expect(child.getByText("Unique option")).toBeTruthy();
});

it("filters all checkpoints locally, resets pagination and retains shared material context", async () => {
  const user = userEvent.setup();
  const client = new Client("fake");
  const image = vi.spyOn(client, "image");
  const records = [material, ...Array.from({ length: 22 }, (_, index) => question({id:`filtered-${index}`, stem:`Record ${index}`, needsReview:index === 21}))];
  const view = { ...preview, units: [{...preview.units[0], questions:records}] };
  const before = JSON.stringify(view);
  render(<ResultReview task={task} preview={view} client={client}/>);
  await user.click(screen.getByRole("button", {name:"下一页题目"}));
  await user.type(screen.getByRole("searchbox", {name:"搜索解析题目"}), "共享选项一");
  await user.click(screen.getByRole("checkbox", {name:"仅看需要复核"}));
  expect(screen.getByText("Record 21")).toBeTruthy();
  expect(screen.queryByText("Record 20")).toBeNull();
  await user.click(screen.getByText("Record 21"));
  expect(screen.getByRole("heading", {name:"所属材料 · q-material"})).toBeTruthy();
  expect(screen.getByText("共享选项一")).toBeTruthy();
  await user.clear(screen.getByRole("searchbox", {name:"搜索解析题目"}));
  await user.type(screen.getByRole("searchbox", {name:"搜索解析题目"}), "absent");
  expect(screen.getByText(/没有符合筛选的题目/)).toBeTruthy();
  await user.click(screen.getByRole("button", {name:"清除结果筛选"}));
  expect(screen.getByText("Record 0")).toBeTruthy();
  expect(screen.queryByText("Record 21")).toBeNull();
  expect(JSON.stringify(view)).toBe(before);
  expect(image).not.toHaveBeenCalled();
});
