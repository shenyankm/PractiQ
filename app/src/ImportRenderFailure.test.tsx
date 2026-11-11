// @vitest-environment jsdom
import "./import-test-setup";
import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ErrorBoundary } from "../../shared/error-boundary";
import { RenderFailure } from "../../shared/cloud/RenderFailure";
it("keeps surrounding inputs and task actions when a result fails to render", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  function Broken(): never { throw new Error("Bad chunk"); }
  render(<><input aria-label="Retained input" defaultValue="Unsaved" /><button>Query original task</button><ErrorBoundary fallback={<RenderFailure />}><Broken /></ErrorBoundary></>);
  expect((screen.getByLabelText("Retained input") as HTMLInputElement).value).toBe("Unsaved");
  expect(screen.getByRole("button", { name: "Query original task" })).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("在导入记录中查询原任务。");
  expect(screen.getByRole("alert").textContent).not.toMatch(/账户|订单|令牌|重新连接/);
  expect(fetcher).not.toHaveBeenCalled();
});
