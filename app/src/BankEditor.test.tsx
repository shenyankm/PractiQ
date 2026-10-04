// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { BankEditor } from "./BankEditor";

afterEach(cleanup);
const initial = { id: "bank", title: "Original bank", description: "Original description" };

it.each(["Escape", "close"])("closes an unchanged bank immediately through %s", async action => {
  const user = userEvent.setup();
  const close = vi.fn();
  render(<BankEditor initial={initial} busy={false} onClose={close} onSave={vi.fn()} />);
  if (action === "Escape") await user.keyboard("{Escape}");
  else await user.click(screen.getByRole("button", { name: "关闭" }));
  expect(close).toHaveBeenCalledOnce();
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it.each(["Escape", "close"])("keeps changed bank fields through %s and Continue editing", async action => {
  const user = userEvent.setup();
  const close = vi.fn(), save = vi.fn();
  render(<BankEditor initial={initial} busy={false} onClose={close} onSave={save} />);
  await user.type(screen.getByRole("textbox", { name: "题库名称" }), " changed");
  await user.type(screen.getByRole("textbox", { name: "说明" }), " changed");
  if (action === "Escape") await user.keyboard("{Escape}");
  else await user.click(screen.getByRole("button", { name: "关闭" }));
  expect(close).not.toHaveBeenCalled();
  const confirmation = screen.getByRole("alertdialog", { name: "放弃未保存的更改？" });
  expect(document.activeElement).toBe(within(confirmation).getByRole("button", { name: "继续编辑" }));
  await user.click(within(confirmation).getByRole("button", { name: "继续编辑" }));
  await user.click(screen.getByRole("button", { name: "保存题库" }));
  expect(save).toHaveBeenCalledWith({ ...initial, title: "Original bank changed", description: "Original description changed" });
  expect(initial.title).toBe("Original bank");
});

it("closes a reverted bank without prompting and deliberately discards with one click", async () => {
  const user = userEvent.setup();
  const close = vi.fn();
  render(<BankEditor initial={initial} busy={false} onClose={close} onSave={vi.fn()} />);
  const description = screen.getByRole("textbox", { name: "说明" });
  await user.type(description, " changed");
  await user.clear(description);
  await user.type(description, initial.description);
  await user.keyboard("{Escape}");
  expect(close).toHaveBeenCalledOnce();
  await user.type(description, " discarded");
  await user.click(screen.getByRole("button", { name: "放弃更改" }));
  expect(close).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("discards a changed bank from the confirmation without submitting it", async () => {
  const user = userEvent.setup();
  const close = vi.fn(), save = vi.fn();
  render(<BankEditor initial={initial} busy={false} onClose={close} onSave={save} />);
  await user.type(screen.getByRole("textbox", { name: "题库名称" }), " discarded");
  await user.keyboard("{Escape}");
  await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "放弃更改" }));
  expect(close).toHaveBeenCalledOnce();
  expect(save).not.toHaveBeenCalled();
});

it("blocks bank edits, saves and dismissals while a save is in flight", async () => {
  const user = userEvent.setup();
  const close = vi.fn(), save = vi.fn();
  render(<BankEditor initial={initial} busy onClose={close} onSave={save} />);
  await user.type(screen.getByRole("textbox", { name: "题库名称" }), " ignored");
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("button", { name: "关闭" }));
  await user.click(screen.getByRole("button", { name: "放弃更改" }));
  await user.click(screen.getByRole("button", { name: "保存题库" }));
  expect((screen.getByRole("textbox", { name: "题库名称" }) as HTMLInputElement).value).toBe(initial.title);
  expect(close).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
});
