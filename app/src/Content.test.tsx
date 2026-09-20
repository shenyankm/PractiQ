// @vitest-environment jsdom
import { createRequire } from "node:module";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Content } from "./Content";
import type { Snapshot } from "./api";
import fixture from "../fixtures/rich-content/expected.json";
vi.mock("./api", () => ({api: vi.fn().mockResolvedValue(null)}));
afterEach(cleanup);
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
  const { api } = await import("./api");
  const user = (await import("@testing-library/user-event")).default.setup();
  vi.mocked(api).mockClear();
  vi.mocked(api).mockResolvedValue("data:image/png;base64,aW1hZ2U=");
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
