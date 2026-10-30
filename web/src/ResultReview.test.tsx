import { createRequire } from "node:module";
import { StrictMode } from "react";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import ResultReview, { ImageArtifact, Markdown } from "./ResultReview";
import { Client } from "./api";
import { material, preview, question, task } from "./test-fixtures";
import htmlBlocks from "../../app/fixtures/rich-content/html-blocks.json";

it("reuses matching detail questions, groups and images with a metadata-only preview", async () => {
  const user = userEvent.setup();
  const detail = { ...task, result: { ...task.result!, groups: [{ title: "Printed section", questionIds: ["q-child"] }],
    visualElements: [{ kind: "image" as const, description: "Printed figure", questionIds: ["q-child"] }] } };
  const metadata = { ...preview, units: [{ stage: "document_parse" as const, index: 0, questions: [], groups: [],
    sourceRef: { objectKey: "saved-text", sha256: "a".repeat(64), sizeBytes: 10, mediaType: "text/plain" } }] };
  const before = JSON.stringify([detail, metadata]);
  const view = render(<ResultReview task={detail} preview={metadata} client={new Client("fake")} />);
  await user.click(screen.getByText("根据材料选择答案", { selector: "summary span" }));
  expect(screen.getByText("共享选项一")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "来源与资源" }));
  expect(screen.getByText("Printed section")).toBeTruthy();
  expect(screen.getByText("image · Printed figure")).toBeTruthy();
  expect(screen.getByRole("button", { name: "查看来源证据" })).toBeTruthy();
  expect(JSON.stringify([detail, metadata])).toBe(before);
  view.rerender(<ResultReview task={detail} preview={{ ...metadata, checkpointId: "different-checkpoint" }} client={new Client("fake")} />);
  expect(screen.queryByText("Printed section")).toBeNull();
  expect(screen.queryByText("image · Printed figure")).toBeNull();
  await user.click(screen.getByRole("button", { name: "题目与材料" }));
  expect(screen.queryByText("根据材料选择答案", { selector: "summary span" })).toBeNull();
});

it.each(["sourceRef", "evidenceRef"] as const)("loads %s OCR evidence only on demand and renders source markup as inert text", async (field) => {
  const literal = '<script>window.injected=true</script>\\nOCR source';
  const evidence = vi.spyOn(Client.prototype, "evidence").mockResolvedValue({ text: async () => literal } as Blob);
  const reference = { objectKey: "managed-ocr", sha256: "a".repeat(64), sizeBytes: literal.length, mediaType: "application/json" };
  const checkpoint = { ...preview, units: [{ ...preview.units[0], sourceRef: undefined, [field]: reference, visualElements: [] }] };
  const { container } = render(<ResultReview task={task} preview={checkpoint} client={new Client("fake")} />);
  await userEvent.click(screen.getByRole("button", { name: "来源与资源" }));
  expect(evidence).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "查看来源证据" }));
  expect(await screen.findByText(literal)).toBeTruthy();
  expect(container.querySelector("script")).toBeNull();
  expect(evidence).toHaveBeenCalledWith(reference, task.threadId, expect.any(AbortSignal));
});

it("downloads the original document only after an explicit action", async () => {
  let finish!: (blob: Blob) => void;
  const source = vi.spyOn(Client.prototype, "source").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:original");
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  const document = { objectKey: "managed-source", sha256: "a".repeat(64), sizeBytes: 6, mediaType: "text/plain", sourceType: "text" as const, fileName: "source.txt" };
  const view = render(<ResultReview task={task} preview={{ ...preview, document }} client={new Client("fake")} />);
  await userEvent.click(screen.getByRole("button", { name: "来源与资源" }));
  expect(source).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "下载原文件" }));
  expect(source).toHaveBeenCalledWith(document, task.threadId);
  view.unmount();
  await act(async () => finish(new Blob(["source"])));
  expect(click).toHaveBeenCalledTimes(1);
});

for (const source of ["checkpoint", "result"]) {
  it(`does not transfer expanded idless cards after ${source} filtering`, async () => {
    const user = userEvent.setup();
    const records = [
      question({ id: null, stem: "Alpha", needsReview: false }),
      question({ id: null, stem: "Beta", needsReview: true }),
    ];
    const { container } = render(<ResultReview
      task={{ ...task, result: { ...task.result!, questions: records } }}
      preview={source === "checkpoint" ? { ...preview, units: [{ ...preview.units[0], questions: records }] } : null}
      client={new Client("fake")}
    />);
    await user.click(screen.getByText("Alpha", { selector: "summary span" }));
    expect(screen.getByRole("heading", { name: "完整题干" })).toBeTruthy();
    await user.type(screen.getByRole("searchbox", { name: "搜索解析题目" }), "Beta");
    expect(container.querySelector("details.question-card")?.hasAttribute("open")).toBe(false);
    expect(screen.queryByRole("heading", { name: "完整题干" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "清除结果筛选" }));
    await user.click(screen.getByText("Alpha", { selector: "summary span" }));
    await user.click(screen.getByRole("checkbox", { name: "仅看需要复核" }));
    expect(container.querySelector("details.question-card")?.hasAttribute("open")).toBe(false);
    expect(screen.queryByRole("heading", { name: "完整题干" })).toBeNull();
  });
}

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
  const notices = within(screen.getByRole("region", { name: "结果提醒" }));
  expect(notices.getByText(/这是部分结果/)).toBeTruthy();
  expect(notices.getByText("保留失败单元；参考答案缺失。")).toBeTruthy();
  expect(notices.getByText(/文档缺失字段/)).toBeTruthy();
  expect(notices.getByText(/待人工复核/)).toBeTruthy();
  await user.click(screen.getByText("根据材料选择答案"));
  expect(screen.getByText("未提供（null），不会补写答案")).toBeTruthy();
  expect(screen.getByText("共享选项一")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "所属材料 · q-material" })).toBeTruthy();
  expect(screen.getByText("原文包含题目，但未提供参考答案。")).toBeTruthy();
  await user.click(screen.getByText("完整结构化记录（只读）"));
  expect(screen.getByText(/"answerPayload": null/)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "来源与资源" }));
  expect(screen.getByText("阅读分组")).toBeTruthy();
  expect(screen.queryByText(/"questionId": "q-child"/)).toBeNull();
  await user.click(screen.getByText("题目来源关联", { selector: "summary" }));
  expect(screen.getAllByText(/"questionId": "q-child"/).length).toBeGreaterThan(0);
  expect(screen.getByText(/"unitIndex": 0/)).toBeTruthy();
});
it("omits result notices when no result needs attention", () => {
  render(<ResultReview task={{ ...task, status: null, result: null }} preview={{ ...preview, quality: { ...preview.quality, reviewRequired: false } }} client={new Client("fake")} />);
  expect(screen.queryByRole("region", { name: "结果提醒" })).toBeNull();
});
it("shows duplicate warnings in full and filters retained copies by ID without modifying results", async () => {
  const user = userEvent.setup(); const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const warning = "Possible duplicate question trees: q0; q2. All copies were retained; review them before deciding whether to remove any.";
  const copies = ["q0", "q2"].map(id => question({ id, parentId: null, optionSourceId: null, stem: "重复题目" }));
  const sources = copies.map((q, unitIndex) => ({ questionId: q.id!, stage: "document_parse" as const, unitIndex }));
  const detail = { ...task, result: { ...task.result!, questions: copies, groups: [], visualElements: [], warnings: [warning] } };
  const checkpoint = { ...preview, units: copies.map((q, index) => ({ ...preview.units[0], stage: "document_parse" as const, index, questions: [q], groups: [], visualElements: [] })), questionSources: sources };
  const before = JSON.stringify({ detail, checkpoint });
  render(<ResultReview task={detail} preview={checkpoint} client={new Client("fake")} />);
  expect(screen.getByText(warning)).toBeTruthy();
  expect(screen.getAllByText("重复题目", { selector: "summary span" })).toHaveLength(2);
  const search = screen.getByRole("searchbox", { name: "搜索解析题目" });
  expect(search.getAttribute("placeholder")).toBe("搜索题目 ID、题干、选项或来源原文");
  await user.type(search, "Q2");
  expect(screen.getByText(/显示 1 \/ 2 条记录/)).toBeTruthy();
  await user.click(screen.getByText("重复题目", { selector: "summary span" }));
  expect(screen.getByText("q2")).toBeTruthy(); expect(screen.getAllByText("document_parse · 1").length).toBeGreaterThan(0);
  await user.click(screen.getByRole("button", { name: "清除结果筛选" }));
  expect(screen.getAllByText("重复题目", { selector: "summary span" })).toHaveLength(2);
  await user.click(screen.getAllByText("重复题目", { selector: "summary span" })[0]);
  expect(screen.getByText("q0")).toBeTruthy(); expect(screen.getAllByText("document_parse · 0").length).toBeGreaterThan(0);
  expect(screen.getByText(warning)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /删除|移除|合并/ })).toBeNull();
  expect(fetcher).not.toHaveBeenCalled(); expect(JSON.stringify({ detail, checkpoint })).toBe(before);
});
it("shows HTML blocks as inert source text and retains missing stems/types", async () => {
  const user = userEvent.setup(); const { container } = render(<ResultReview task={task} preview={preview} client={new Client("fake")} />);
  await user.click(screen.getByText("题干未提供（null）"));
  expect(screen.getByText("<script>window.documentInjected=true</script>")).toBeTruthy();
  expect(container.querySelector("script")).toBeNull();
  expect(screen.getByText("题型未知（null）")).toBeTruthy();
});
it("retains the same HTML source fields as the App without activating markup", async () => {
  const q = question({ id: "q-html", stem: "Escaped HTML fixture", parentId: null, optionSourceId: null,
    contentBlocks: htmlBlocks as ReturnType<typeof question>["contentBlocks"] });
  const { container } = render(<ResultReview task={{ ...task, result: { ...task.result!, questions: [q], groups: [], visualElements: [] } }} preview={null} client={new Client("fake")} />);
  await userEvent.click(screen.getByText("Escaped HTML fixture"));
  for (const value of new Set(htmlBlocks.flatMap(block => [block.textValue, block.markdownValue]))) expect(screen.getByText(value).tagName).toBe("PRE");
  expect(container.querySelector("script,img,table,a")).toBeNull();
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
  const view = render(<ImageArtifact reference={reference} description="图片" client={client} threadId={task.threadId} />);
  await user.click(screen.getByRole("button", { name: "查看图片" })); view.unmount(); await act(async () => finish(new Blob(["x"]))); expect(create).not.toHaveBeenCalled();
  render(<ImageArtifact reference={reference} description="图片" client={client} threadId={task.threadId} />);
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
  expect(screen.getByText(/没有匹配题目，请调整或清除筛选/)).toBeTruthy();
  await user.click(screen.getByRole("button", {name:"清除结果筛选"}));
  expect(screen.getByText("Record 0")).toBeTruthy();
  expect(screen.queryByText("Record 21")).toBeNull();
  expect(JSON.stringify(view)).toBe(before);
  expect(image).not.toHaveBeenCalled();
});

it.each([
  [{correct:["A","B"]}, "A、B"],
  [{correct:["A",null]}, "A、未提供答案（null）"],
  [{correct:[null]}, "未提供答案（null）"],
  [{value:false}, "错误"],
  [{correct:[]}, "参考答案为空"],
  [{answers:[]}, "参考答案为空"],
  [{order:[]}, "参考答案为空"],
  [{matches:[]}, "参考答案为空"],
  [{answers:["First",null]}, "该空未提供答案（null）"],
  [{text:"Reference **answer**"}, "answer"],
  [{order:[2,1]}, "Second"],
  [{order:[1,null]}, "未提供答案（null）"],
  [{matches:[{left:1,right:2}]}, "First → Second"],
  [{matches:[{left:1,right:null}]}, "First → 未提供答案（null）"],
  [{matches:[{left:null,right:2}]}, "未提供答案（null） → Second"],
  [{matches:[null]}, "未提供答案（null）"],
  [{matches:[{left:1}]}, "First → 未提供答案（null）"],
  [{unrecognized:{raw:"preserved"}}, "答案结构需人工核对，请展开来源与技术详情。"],
  [null, "未提供（null），不会补写答案"],
] as const)("prioritizes readable reference answers and retains raw evidence: %j", async (answer, text) => {
  const q = question({id:"readable", stem:"Readable review", parentId:null, optionSourceId:null, answerPayload:structuredClone(answer) as ReturnType<typeof question>["answerPayload"], items:[{id:1,side:"left",content:"First"},{id:2,side:"right",content:"Second"}]});
  const original = JSON.stringify(q);
  const {container} = render(<ResultReview task={{...task,result:{...task.result!,questions:[q]}}} preview={null} client={new Client("fake")}/>);
  await userEvent.click(screen.getByText("Readable review", {selector:"summary span"}));
  const card = container.querySelector(".question-card")!;
  const reference = screen.getByRole("heading", {name:"文档提供的参考答案"}).parentElement!;
  expect(within(reference).getByText(text)).toBeTruthy();
  const technical = card.querySelector<HTMLDetailsElement>(".review-technical")!;
  expect(technical.open).toBe(false);
  expect(card.querySelector(".metadata-grid")!.closest(".review-technical")).toBe(technical);
  await userEvent.click(screen.getByText("来源与技术详情"));
  await userEvent.click(screen.getByText("完整结构化记录（只读）"));
  expect(technical.textContent).toContain(JSON.stringify(q, null, 2));
  expect(JSON.stringify(q)).toBe(original);
});

it.each([
  {answer:{order:[1,0]}, items:[{content:"First"},{id:null,content:"Second"}], expected:["Second","First"]},
  {answer:{order:[8,1]}, items:[{id:8,content:"First"},{content:"Second"}], expected:["First","Second"]},
  {answer:{order:[0,null,1]}, items:[{content:"First"},{content:"Second"}], expected:["First","未提供答案（null）","Second"]},
  {answer:{matches:[{left:0,right:null},null,{left:null,right:0}]}, items:[{side:"left",content:"First"},{side:"right",content:"Second"}], expected:["First → 未提供答案（null）","未提供答案（null）","未提供答案（null） → Second"]},
  {answer:{matches:[{left:0,right:1},{left:7,right:0}]}, items:[{side:"right",content:"Right first"},{side:"left",content:"Left first"},{side:"right",id:null,content:"Right second"},{side:"left",id:7,content:"Left second"}], expected:["Left first → Right second","Left second → Right first"]},
] as const)("resolves optional item IDs using contract positions: %j", async ({answer,items,expected}) => {
  const q=question({stem:"Positional answers",answerMode:"order" in answer ? "ordering" : "matching",answerPayload:structuredClone(answer) as ReturnType<typeof question>["answerPayload"],items:items.map(item=>({...item}))});
  const original=JSON.stringify(q);
  render(<ResultReview task={{...task,result:{...task.result!,questions:[q]}}} preview={null} client={new Client("fake")}/>);
  await userEvent.click(screen.getByText("Positional answers",{selector:"summary span"}));
  const reference=screen.getByRole("heading",{name:"文档提供的参考答案"}).parentElement!;
  expect(within(reference).getAllByRole("listitem").map(item=>item.textContent)).toEqual(expected);
  expect(reference.textContent).not.toContain("未关联题项");
  expect(JSON.stringify(q)).toBe(original);
});

it.each(["image", "evidence"] as const)("cancels a stalled %s body when its viewer leaves the resources tab", async kind => {
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({ cancel }));
  const fetcher = vi.fn(async (_path: string, _init: RequestInit) => response);
  vi.stubGlobal("fetch", fetcher);
  const digest = vi.spyOn(crypto.subtle, "digest");
  const reference = { objectKey: "managed", sha256: "a".repeat(64), sizeBytes: 1, mediaType: kind === "image" ? "image/png" : "text/plain" };
  const checkpoint = { ...preview, units: [{ ...preview.units[0], sourceRef: reference, evidenceRef: null, visualElements: [] }] };
  render(<ResultReview task={task} preview={checkpoint} client={new Client("fake")} />);
  await userEvent.click(screen.getByRole("button", { name: "来源与资源" }));
  await userEvent.click(screen.getByRole("button", { name: kind === "image" ? "查看图片" : "查看来源证据" }));
  expect(response.body?.locked).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: "题目与材料" }));
  expect(fetcher.mock.calls[0][1].signal?.aborted).toBe(true);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(response.body?.locked).toBe(false);
  expect(digest).not.toHaveBeenCalled();
  expect(screen.queryByRole("alert")).toBeNull();
});

for (const kind of ["image", "evidence"] as const) {
  it.each(["client", "task", "objectKey", "sha256", "sizeBytes", "mediaType"] as const)(`resets ${kind} on %s replacement and ignores late publication in StrictMode`, async identity => {
    const user = userEvent.setup();
    const client = new Client("fake");
    const reference = { objectKey: "managed", sha256: "a".repeat(64), sizeBytes: 1, mediaType: kind === "image" ? "image/png" : "text/plain" };
    const nextReference = { ...reference,
      ...(identity === "objectKey" ? { objectKey: "replacement" } : {}),
      ...(identity === "sha256" ? { sha256: "b".repeat(64) } : {}),
      ...(identity === "sizeBytes" ? { sizeBytes: 2 } : {}),
      ...(identity === "mediaType" ? { mediaType: kind === "image" ? "image/jpeg" : "text/markdown" } : {}),
    };
    let finish!: () => void;
    const currentBlob = kind === "image" ? new Blob(["current"]) : { text: async () => "current evidence" } as Blob;
    const read = vi.spyOn(Client.prototype, kind).mockImplementationOnce(() => kind === "image"
      ? new Promise<Blob>(resolve => { finish = () => resolve(new Blob(["stale"])); })
      : Promise.resolve({ text: () => new Promise<string>(resolve => { finish = () => resolve("stale evidence"); }) } as Blob))
      .mockResolvedValue(currentBlob);
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:current");
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const review = (ref: typeof reference, owner = client, threadId = task.threadId) => <StrictMode><ResultReview task={{ ...task, threadId }} preview={{ ...preview, units: [{ ...preview.units[0], sourceRef: ref, evidenceRef: null, visualElements: [] }] }} client={owner} /></StrictMode>;
    const view = render(review(reference));
    await user.click(screen.getByRole("button", { name: "来源与资源" }));
    const loadLabel = kind === "image" ? "查看图片" : "查看来源证据";
    await user.click(screen.getByRole("button", { name: loadLabel }));
    const oldSignal = read.mock.calls[0][2]!;
    const nextClient = identity === "client" ? new Client("replacement") : client;
    const nextTask = identity === "task" ? "replacement-task" : task.threadId;
    view.rerender(review(nextReference, nextClient, nextTask));
    expect(oldSignal.aborted).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
    await user.click(screen.getByRole("button", { name: loadLabel }));
    await act(async () => finish());
    const currentSignal = read.mock.calls[1][2]!;
    expect(currentSignal.aborted).toBe(false);
    if (kind === "image") {
      expect(create).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledWith(currentBlob);
      expect(screen.getByRole("img").getAttribute("src")).toBe("blob:current");
    } else {
      expect(screen.getByText("current evidence")).toBeTruthy();
      expect(screen.queryByText("stale evidence")).toBeNull();
    }
    // Equivalent checkpoint references must not reset a loaded view or its controller.
    view.rerender(review({ ...nextReference }, nextClient, nextTask));
    expect(currentSignal.aborted).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
    view.rerender(review(reference));
    expect(currentSignal.aborted).toBe(true);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByText("current evidence")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    if (kind === "image") expect(revoke).toHaveBeenCalledWith("blob:current");
  });
}

it("reloads images explicitly and releases each replaced object URL", async () => {
  const client = new Client("fake");
  const image = vi.spyOn(client, "image").mockResolvedValue(new Blob(["image"]));
  vi.spyOn(URL, "createObjectURL").mockReturnValueOnce("blob:first").mockReturnValueOnce("blob:second");
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  const reference = { objectKey: "managed", sha256: "a".repeat(64), sizeBytes: 1, mediaType: "image/png" };
  const view = render(<StrictMode><ImageArtifact reference={reference} description="图片" client={client} threadId={task.threadId} /></StrictMode>);
  await userEvent.click(screen.getByRole("button", { name: "查看图片" }));
  await userEvent.click(screen.getByRole("button", { name: "重新读取图片" }));
  expect(image).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("img").getAttribute("src")).toBe("blob:second");
  expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:first");
  view.unmount();
  expect(revoke.mock.calls).toEqual([["blob:first"], ["blob:second"]]);
});

it("offers explicit evidence retry after failure and suppresses a late cancellation error", async () => {
  let fail!: (error: Error) => void;
  const read = vi.spyOn(Client.prototype, "evidence").mockRejectedValueOnce(new Error("integrity"))
    .mockResolvedValueOnce({ text: async () => "verified evidence" } as Blob)
    .mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  const reference = { objectKey: "managed", sha256: "a".repeat(64), sizeBytes: 1, mediaType: "text/plain" };
  const client = new Client("fake");
  const checkpoint = { ...preview, units: [{ ...preview.units[0], sourceRef: reference, evidenceRef: null, visualElements: [] }] };
  const view = render(<ResultReview task={task} preview={checkpoint} client={client} />);
  await userEvent.click(screen.getByRole("button", { name: "来源与资源" }));
  await userEvent.click(screen.getByRole("button", { name: "查看来源证据" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "查看来源证据" }));
  expect(await screen.findByText("verified evidence")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "查看来源证据" }));
  view.rerender(<ResultReview task={{ ...task, threadId: "replacement-task" }} preview={checkpoint} client={client} />);
  await act(async () => fail(new DOMException("cancelled", "AbortError")));
  expect(read.mock.calls[2][2]?.aborted).toBe(true);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText("verified evidence")).toBeNull();
  expect((screen.getByRole("button", { name: "查看来源证据" }) as HTMLButtonElement).disabled).toBe(false);
});
