// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ImportBankDialog } from "./ImportBankDialog";
import { api, type Preview } from "./api";

vi.mock("./api", async () => ({ ...await vi.importActual("./api"), api: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it.each(["PARTIAL", "SUCCEEDED"])("warns about appending a %s snapshot before confirming", async status => {
  const user = userEvent.setup();
  const preview: Preview = { ticket: "ticket", title: "Snapshot", count: 1, reviewCount: 0, warnings: [], status, processing: null, missingAssets: [], assetCount: 0 };
  const onImported = vi.fn();
  vi.mocked(api).mockResolvedValue({ bankId: "bank", count: 1, duplicate: false } as never);
  render(<ImportBankDialog preview={preview} banks={[{ id: "bank", title: "Existing", count: 1 }]} initialBank="new" busy={false} run={job => void job()} onClose={vi.fn()} onImported={onImported} />);
  expect(screen.queryByRole("alert")).toBeNull();
  await user.selectOptions(screen.getByRole("combobox", { name: "导入到" }), "bank");
  expect(screen.getByRole("alert").textContent).toContain("部分结果与最终完整结果追加到同一题库，会重复加入已有题目");
  expect(api).not.toHaveBeenCalled();
  await user.selectOptions(screen.getByRole("combobox", { name: "导入到" }), "new");
  expect(screen.queryByRole("alert")).toBeNull();
  await user.selectOptions(screen.getByRole("combobox", { name: "导入到" }), "bank");
  await user.click(screen.getByRole("button", { name: "确认导入" }));
  expect(api).toHaveBeenCalledExactlyOnceWith({ type: "import", ticket: "ticket", bank_id: "bank", title: "Snapshot" });
});
