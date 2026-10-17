// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NativeSelect, NativeSelectOption } from "./components/ui/native-select";

const originalMatchMedia = window.matchMedia;
afterEach(() => { cleanup(); window.matchMedia = originalMatchMedia; vi.restoreAllMocks(); vi.unstubAllGlobals(); Reflect.deleteProperty(HTMLElement.prototype, "hasPointerCapture"); Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView"); });

function viewport(desktop: boolean) {
  const listeners = new Set<() => void>();
  window.matchMedia = (query: string) => ({ matches: desktop, media: query, addEventListener: (_: string, listener: () => void) => listeners.add(listener), removeEventListener: (_: string, listener: () => void) => listeners.delete(listener) }) as unknown as MediaQueryList;
  Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", { configurable: true, value: () => false });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => {} });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  return (next: boolean) => act(() => { desktop = next; listeners.forEach(listener => listener()); });
}
const options = [<NativeSelectOption key="all" value="">全部</NativeSelectOption>, <NativeSelectOption key="failed" value="failed">失败</NativeSelectOption>, <NativeSelectOption key="blocked" value="blocked" disabled>不可选</NativeSelectOption>];

it("preserves empty filter values, disabled options and labels in the custom desktop menu", async () => {
  viewport(true);
  const change = vi.fn();
  const user = userEvent.setup();
  render(<label>状态<NativeSelect value="failed" onValueChange={change}>{options}</NativeSelect></label>);
  const control = screen.getByRole("combobox", { name: "状态" });
  await user.click(control);
  expect(screen.getByRole("option", { name: "不可选" }).getAttribute("data-disabled")).toBe("");
  await user.keyboard("{Home}{Enter}");
  expect(change).toHaveBeenCalledExactlyOnceWith("");
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(document.activeElement).toBe(control);
});

it("retains an uncontrolled selection when switching between system and custom pickers", async () => {
  const resize = viewport(false);
  const user = userEvent.setup();
  const change = vi.fn();
  const view = render(<NativeSelect aria-label="状态" defaultValue="" onValueChange={change}>{options}</NativeSelect>);
  await user.selectOptions(screen.getByRole("combobox", { name: "状态" }), "failed");
  resize(true);
  expect(screen.getByRole("combobox").textContent).toContain("失败");
  resize(false);
  expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("failed");
  expect(change).toHaveBeenCalledExactlyOnceWith("failed");
  view.rerender(<NativeSelect aria-label="状态" disabled>{options}</NativeSelect>);
  resize(true);
  await user.click(screen.getByRole("combobox"));
  expect(screen.queryByRole("listbox")).toBeNull();
});
