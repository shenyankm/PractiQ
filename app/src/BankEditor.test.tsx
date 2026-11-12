// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { BankEditor } from "./BankEditor";

afterEach(cleanup);
const initial = { id: "bank", title: "Bank", description: "Original description" };

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
  expect(save).toHaveBeenCalledWith({ ...initial, title: "Bank changed", description: "Original description changed" });
  expect(initial.title).toBe("Bank");
});

it("closes a reverted bank without prompting and confirms discarding a dirty bank", async () => {
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
  expect(close).toHaveBeenCalledOnce();
  await user.click(within(screen.getByRole("alertdialog")).getByRole("button", {name:"放弃更改"}));
  expect(close).toHaveBeenCalledTimes(2);
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
  await user.click(screen.getByRole("button", { name: "取消" }));
  await user.click(screen.getByRole("button", { name: "保存题库" }));
  expect((screen.getByRole("textbox", { name: "题库名称" }) as HTMLInputElement).value).toBe(initial.title);
  expect(close).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
});

it("labels an unchanged new bank dismissal Cancel", async () => {
 const close=vi.fn();
 render(<BankEditor initial={{id:null,title:"",description:""}} busy={false} onClose={close} onSave={vi.fn()}/>);
 await userEvent.click(screen.getByRole("button", {name:"取消"}));
 expect(close).toHaveBeenCalledOnce();
 expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("counts Unicode characters and blocks bank saves beyond 15 / 50", async () => {
  const user = userEvent.setup(), save = vi.fn();
  render(<BankEditor initial={{id:null,title:"",description:""}} busy={false} onClose={vi.fn()} onSave={save}/>);
  const title = screen.getByLabelText("题库名称"), description = screen.getByLabelText("说明");
  const button = screen.getByRole("button", {name:"保存题库"});
  await user.type(title, "题".repeat(15));
  await user.type(description, "述".repeat(50));
  expect(screen.getByText("15 / 15 字")).toBeTruthy();
  expect(screen.getByText("50 / 50 字")).toBeTruthy();
  await user.click(button);
  expect(save).toHaveBeenCalledOnce();
  await user.type(title, "超");
  expect(button.hasAttribute("disabled")).toBe(true);
  expect(title.getAttribute("aria-invalid")).toBe("true");
  await user.clear(title);
  await user.paste("🐙".repeat(15));
  expect(screen.getByText("15 / 15 字")).toBeTruthy();
  expect(button.hasAttribute("disabled")).toBe(false);
  await user.type(description, "超");
  expect(button.hasAttribute("disabled")).toBe(true);
  expect(description.getAttribute("aria-invalid")).toBe("true");
  expect(save).toHaveBeenCalledOnce();
});

it("preserves oversized historical metadata until the user shortens it", async () => {
  const user = userEvent.setup(), save = vi.fn();
  render(<BankEditor initial={{id:"old",title:"题".repeat(16),description:"述".repeat(51)}} busy={false} onClose={vi.fn()} onSave={save}/>);
  const title = screen.getByLabelText("题库名称") as HTMLInputElement;
  const description = screen.getByLabelText("说明") as HTMLTextAreaElement;
  const button = screen.getByRole("button", {name:"保存题库"});
  expect(title.value).toHaveLength(16);
  expect(description.value).toHaveLength(51);
  expect(button.hasAttribute("disabled")).toBe(true);
  await user.clear(title);
  await user.type(title, "新名称");
  await user.clear(description);
  await user.click(button);
  expect(save).toHaveBeenCalledWith({id:"old",title:"新名称",description:""});
});
