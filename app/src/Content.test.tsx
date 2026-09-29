// @vitest-environment jsdom
import { createRequire } from "node:module";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { Content } from "./Content";
import { api, type Snapshot } from "./api";
import fixture from "../fixtures/rich-content/expected.json";
vi.mock("./api", () => ({api: vi.fn()}));
beforeEach(() => { vi.mocked(api).mockReset().mockRejectedValue(new Error("missing asset")); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it("renders matrices, aligned integrals, cases and every table cell without losing mixed content", async () => {
  const snapshot = {question: fixture.questions[0], groups: [], sources: [], warnings: [], missingAssets: false,
    visuals: [{...fixture.visualElements[0], extractedText: fixture.questions[0].contentBlocks.at(-1)?.markdownValue, id: "v", questionIds: ["q"]}]} as unknown as Snapshot;
  const {container} = render(<Content snapshot={snapshot}/>);
  expect(container.querySelectorAll(".katex-error")).toHaveLength(0);
  expect(container.querySelectorAll(".katex-display")).toHaveLength(3);
  expect(container.querySelectorAll("math mfrac").length).toBeGreaterThanOrEqual(5);
  expect(container.querySelectorAll("math mtable").length).toBeGreaterThanOrEqual(4);
  expect(container.querySelectorAll("table th")).toHaveLength(4);
  expect(container.querySelectorAll("table td")).toHaveLength(12);
  for (const text of ["-0.002", "+0.003", "left | right", "中文，空值用 —", "final row"]) expect(screen.getByText(text)).toBeTruthy();
  for (const block of fixture.questions[0].contentBlocks.filter(b => b.latexValue)) {
    expect([...container.querySelectorAll('annotation[encoding="application/x-tex"]')].map(n => n.textContent)).toContain(block.latexValue);
  }
  expect(await screen.findByText("图片不可用，可依据下方文字作答或跳过。")).toBeTruthy();
});

it("keeps KaTeX CSS and rehype renderer on the same version", () => {
  const require = createRequire(import.meta.url);
  const renderer = createRequire(require.resolve("rehype-katex"));
  expect(require("katex/package.json").version).toBe(renderer("katex/package.json").version);
});

it("opens the full source lazily, even when the crop is missing, and hides it during exams", async () => {
  const user = (await import("@testing-library/user-event")).default.setup();
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:full-page");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.mocked(api).mockResolvedValue(new ArrayBuffer(5));
  const snapshot = {question: fixture.questions[0], groups: [], sources: [], warnings: [], missingAssets: false,
    visuals: [{...fixture.visualElements[0], imageRef: null, sourceRef: {...fixture.visualElements[0].imageRef, sha256: "full-page"}, id: "v", questionIds: ["q"]}]} as unknown as Snapshot;
  const {rerender} = render(<Content snapshot={snapshot}/>);
  expect(api).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", {name: "查看原页"}));
  expect(await screen.findByRole("dialog", {name: "查看原页"})).toBeTruthy();
  expect(api).toHaveBeenCalledWith({type: "asset", hash: "full-page"});
  await user.keyboard("{Escape}");
  expect(document.activeElement).toBe(screen.getByRole("button", {name: "查看原页"}));
  rerender(<Content snapshot={snapshot} exam/>);
  expect(screen.queryByRole("button", {name: "查看原页"})).toBeNull();
});

it("fetches shared image bytes only when figures approach the viewport", async () => {
  const observers: IntersectionObserverCallback[] = [];
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { observers.push(callback); }
    observe() {}
    disconnect() {}
  });
  try {
    vi.mocked(api).mockResolvedValue(new ArrayBuffer(4));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:visible");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const visual = {...fixture.visualElements[0],sourceRef:null,questionIds:["q"]};
    const snapshot = {question:fixture.questions[0],groups:[],sources:[],warnings:[],missingAssets:false,
      visuals:[{...visual,id:"one"},{...visual,id:"two"}]} as unknown as Snapshot;
    const view = render(<Content snapshot={snapshot}/>);
    expect(api).not.toHaveBeenCalled();
    await act(async () => { for (const callback of observers) callback([{isIntersecting:true} as IntersectionObserverEntry], {} as IntersectionObserver); });
    expect(await screen.findAllByRole("button",{name:"放大查看图片"})).toHaveLength(2);
    expect(api).toHaveBeenCalledTimes(1);
    view.unmount();
    await act(async () => {});
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:visible");
  } finally { vi.unstubAllGlobals(); }
});
