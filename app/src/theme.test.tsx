// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useTheme } from "./theme";

afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); document.documentElement.classList.remove("dark"); });

it("follows system changes, persists overrides and preserves the selection on save failure", () => {
  let systemDark = false;
  const listeners = new Set<() => void>();
  vi.spyOn(window, "matchMedia").mockImplementation(query => ({
    media: query, get matches() { return systemDark; }, onchange: null,
    addListener() {}, removeListener() {}, dispatchEvent: () => true,
    addEventListener: (_type: string, listener: unknown) => { listeners.add(listener as () => void); },
    removeEventListener: (_type: string, listener: unknown) => { listeners.delete(listener as () => void); },
  }));
  const system = (dark: boolean) => act(() => { systemDark = dark; listeners.forEach(listener => listener()); });
  const first = renderHook(useTheme);
  expect(first.result.current.theme).toBe("system");
  system(true);
  expect(document.documentElement.classList.contains("dark")).toBe(true);
  act(() => { first.result.current.change("light"); });
  system(false); system(true);
  expect(first.result.current.dark).toBe(false);
  first.unmount();
  expect(listeners.size).toBe(0);
  const second = renderHook(useTheme);
  expect(second.result.current.theme).toBe("light");
  act(() => { second.result.current.change("dark"); });
  expect(second.result.current.dark).toBe(true);
  const save = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw Error("Storage unavailable"); });
  act(() => { expect(second.result.current.change("light")).toBe(false); });
  expect(second.result.current.theme).toBe("dark");
  expect(second.result.current.error).toBeTruthy();
  save.mockRestore();
  act(() => { second.result.current.change("system"); });
  expect(second.result.current.error).toBeNull();
  system(false);
  expect(document.documentElement.style.colorScheme).toBe("light");
});
