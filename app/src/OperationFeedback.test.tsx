// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ErrorNotice } from "./OperationFeedback";
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it.each([false, true])("keeps diagnostics collapsed, then handles copy failure=%s", async fail => {
  const user = userEvent.setup();
  const writeText = vi.spyOn(navigator.clipboard, "writeText").mockImplementation(async () => { if (fail) throw new Error("Clipboard unavailable"); });
  render(<ErrorNotice error={{ code: "OPERATION_FAILED", diagnostic: "Disk full", requestId: "request-123" }} />);
  expect(screen.getByText(/Disk full/).closest("details")?.open).toBe(false);
  await user.click(screen.getByText("诊断详情", { exact: true }));
  await user.click(screen.getByRole("button", { name: "复制诊断" }));
  expect(writeText).toHaveBeenCalledWith(expect.stringContaining("request-123"));
  expect(await screen.findByRole("status")).toHaveProperty("textContent", fail ? "复制失败，请手动选择诊断文字。" : "诊断已复制");
});
