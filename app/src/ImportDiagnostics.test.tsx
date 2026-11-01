// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { ImportDiagnostics } from "./ImportDiagnostics";
import type { BankImportDiagnostic } from "./contracts.generated";

afterEach(cleanup);
it("keeps snapshot failures and review reasons readable as escaped diagnostic text", async () => {
  const diagnostic: BankImportDiagnostic = { questionIds: ["q"], status: "PARTIAL", processing: {
    chunks: { total: 2, succeeded: 1, skipped: 0 }, visuals: { total: 0, succeeded: 0, skipped: 0 },
    truncated: true, failures: [{ stage: "document_parse", index: 1, code: "<img src=x onerror=alert(1)>", retryable: true }],
    questionSources: [], quality: { reviewRequired: true, reviewQuestionCount: 1, issues: [{ questionId: "q", code: "SOURCE_TEXT_NOT_FOUND" }] },
  } };
  const { container } = render(<ImportDiagnostics diagnostics={[diagnostic]} />);
  await userEvent.setup().click(screen.getByText("导入解析诊断"));
  expect(await screen.findByText("这是部分解析结果，可能未包含原文的全部题目。")).toBeTruthy();
  expect(screen.getByText(/SOURCE_TEXT_NOT_FOUND/).textContent).toContain('"index": 1');
  expect(container.querySelector("img")).toBeNull();
});

it("does not display a diagnostic panel for banks without saved diagnostics", () => {
  render(<ImportDiagnostics />);
  expect(screen.queryByText("导入解析诊断")).toBeNull();
});
