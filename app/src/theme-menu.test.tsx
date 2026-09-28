// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, expect, it, vi } from "vitest";
import App from "./App";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false, invoke: vi.fn() }));
vi.mock("./api", async () => ({
  ...await vi.importActual<typeof import("./api")>("./api"),
  api: vi.fn(async ({ type }: { type: string }) => {
    if (type === "banks") return [];
    if (type === "info") return { dataDirectory: "/tmp/practiq-theme-test", version: "test" };
    throw Error(`Unexpected request: ${type}`);
  }),
}));

afterEach(() => {
  cleanup(); toast.dismiss(); vi.restoreAllMocks(); localStorage.clear();
  document.documentElement.className = "";
  document.documentElement.style.colorScheme = "";
  Reflect.deleteProperty(document, "startViewTransition");
});

it("closes the menu and restores keyboard focus before capturing, with Toast and root in sync", async () => {
  const user = userEvent.setup();
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  let captured: unknown;
  const start = vi.fn((update: () => Promise<void>) => {
    const menu = screen.queryByRole("menu");
    const focused = document.activeElement === screen.getByRole("button", { name: "主题" });
    const ready = update().then(() => {
      captured = { menu, focused, scheme: document.documentElement.style.colorScheme, toast: document.querySelector("[data-sonner-toaster]")?.getAttribute("data-sonner-theme") };
      finish();
    });
    return { ready, finished, skipTransition() {} };
  });
  Object.defineProperty(document, "startViewTransition", { configurable: true, value: start });
  render(<App />);
  toast("Theme check", { duration: Infinity });
  await screen.findByText("Theme check");
  await user.click(screen.getByRole("button", { name: "主题" }));
  const dark = screen.getByRole("menuitemradio", { name: "黑夜" });
  dark.focus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(captured).toEqual({ menu: null, focused: true, scheme: "dark", toast: "dark" }));
  await waitFor(() => expect(document.documentElement.classList.contains("theme-transition")).toBe(false));
  expect(localStorage.getItem("practiq-theme")).toBe("dark");
  await user.click(screen.getByRole("button", { name: "主题" }));
  expect(screen.getByRole("menuitemradio", { name: "黑夜" }).getAttribute("aria-checked")).toBe("true");
});

it("keeps the menu and selection on save failure, then closes and clears the error on retry", async () => {
  localStorage.setItem("practiq-theme", "dark");
  const user = userEvent.setup();
  render(<App />);
  toast("Retry check", { duration: Infinity });
  await screen.findByText("Retry check");
  await user.click(screen.getByRole("button", { name: "主题" }));
  const save = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw Error("Storage full"); });
  await user.click(screen.getByRole("menuitemradio", { name: "白天" }));
  expect(screen.getByRole("alert").textContent).toContain("主题设置失败，请重试");
  expect(screen.getByRole("menuitemradio", { name: "黑夜" }).getAttribute("aria-checked")).toBe("true");
  expect(document.documentElement.style.colorScheme).toBe("dark");
  save.mockRestore();
  await user.click(screen.getByRole("menuitemradio", { name: "白天" }));
  await waitFor(() => expect(document.documentElement.style.colorScheme).toBe("light"));
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "主题" }));
  expect(document.querySelector("[data-sonner-toaster]")?.getAttribute("data-sonner-theme")).toBe("light");
  await user.click(screen.getByRole("button", { name: "主题" }));
  expect(screen.queryByRole("alert")).toBeNull();
});
