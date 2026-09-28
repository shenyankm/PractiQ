// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { initializeTheme, useTheme } from "./theme";

let systemDark = false;
let reducedMotion = false;
const listeners = new Set<() => void>();
const root = document.documentElement;
beforeEach(() => {
  systemDark = false;
  reducedMotion = false;
  vi.spyOn(window, "matchMedia").mockImplementation(query => ({
    media: query, get matches() { return query.includes("reduced-motion") ? reducedMotion : systemDark; }, onchange: null,
    addListener() {}, removeListener() {}, dispatchEvent: () => true,
    addEventListener: (_type: string, listener: unknown) => { listeners.add(listener as () => void); },
    removeEventListener: (_type: string, listener: unknown) => { listeners.delete(listener as () => void); },
  }));
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); localStorage.clear();
  root.className = ""; root.style.colorScheme = "";
  Reflect.deleteProperty(document, "startViewTransition"); listeners.clear();
});
const system = (dark: boolean) => act(() => { systemDark = dark; listeners.forEach(listener => listener()); });

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function installTransition() {
  const calls: { update: () => Promise<void>; ready: ReturnType<typeof deferred>; finished: ReturnType<typeof deferred>; skip: ReturnType<typeof vi.fn> }[] = [];
  const start = vi.fn((update: () => Promise<void>) => {
    const call = { update, ready: deferred(), finished: deferred(), skip: vi.fn() };
    calls.push(call);
    return { ready: call.ready.promise, finished: call.finished.promise, skipTransition: call.skip };
  });
  Object.defineProperty(document, "startViewTransition", { configurable: true, value: start });
  return { calls, start };
}

it.each(["light", "dark", "system", "invalid"])("initializes %s before React and reuses the read result", value => {
  systemDark = true;
  localStorage.setItem("practiq-theme", value);
  const read = vi.spyOn(Storage.prototype, "getItem");
  const initial = initializeTheme();
  expect(root.classList.contains("dark")).toBe(value !== "light");
  expect(root.style.colorScheme).toBe(value === "light" ? "light" : "dark");
  const { result } = renderHook(() => useTheme(initial), { wrapper: StrictMode });
  expect(result.current.theme).toBe(value === "invalid" ? "system" : value);
  expect(result.current.dark).toBe(value !== "light");
  expect(read).toHaveBeenCalledTimes(1);
  expect(listeners.size).toBe(value === "light" || value === "dark" ? 0 : 1);
});

it("uses the system on read failure, exposes the error, and recovers on save", () => {
  systemDark = true;
  const error = Error("Storage unavailable");
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw error; });
  const initial = initializeTheme();
  expect(initial.error).toBe(error);
  expect(root.style.colorScheme).toBe("dark");
  const { result } = renderHook(() => useTheme(initial));
  act(() => { expect(result.current.change("light")).toBe(true); });
  expect(result.current.error).toBeNull();
  expect(result.current.dark).toBe(false);
});

it("subscribes only in system mode, refreshes on return, and preserves selection on save failure", () => {
  const first = renderHook(useTheme);
  expect(first.result.current.theme).toBe("system");
  system(true);
  expect(root.classList.contains("dark")).toBe(true);
  act(() => { first.result.current.change("light"); });
  expect(listeners.size).toBe(0);
  system(false); system(true);
  expect(first.result.current.dark).toBe(false);
  first.unmount();
  const second = renderHook(useTheme);
  expect(second.result.current.theme).toBe("light");
  act(() => { second.result.current.change("dark"); });
  const save = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw Error("Storage unavailable"); });
  act(() => { expect(second.result.current.change("light")).toBe(false); });
  expect(second.result.current.theme).toBe("dark");
  expect(second.result.current.error).toBeTruthy();
  save.mockRestore();
  system(false);
  act(() => { second.result.current.change("system"); });
  expect(second.result.current.error).toBeNull();
  expect(second.result.current.dark).toBe(false);
  expect(listeners.size).toBe(1);
  system(true);
  expect(root.style.colorScheme).toBe("dark");
  second.unmount();
  expect(listeners.size).toBe(0);
});

it("changes DOM and React together inside the snapshot callback and cleans up", async () => {
  const { calls, start } = installTransition();
  const { result } = renderHook(useTheme);
  act(() => { result.current.change("dark"); });
  expect(start).toHaveBeenCalledTimes(1);
  expect(result.current.dark).toBe(false);
  expect(root.style.colorScheme).toBe("light");
  act(() => {
    calls[0].update();
    expect(result.current.dark).toBe(true);
    expect(root.style.colorScheme).toBe("dark");
  });
  expect(root.classList.contains("theme-changing")).toBe(false);
  await act(async () => { calls[0].ready.resolve(); calls[0].finished.resolve(); });
  expect(root.classList.contains("theme-transition")).toBe(false);
});

it("does not animate startup, system events, equal colors or reduced motion", () => {
  const { start } = installTransition();
  const { result } = renderHook(() => useTheme(initializeTheme()));
  system(true);
  act(() => { result.current.change("dark"); });
  act(() => { result.current.change("system"); });
  reducedMotion = true;
  act(() => { result.current.change("light"); });
  expect(result.current.dark).toBe(false);
  expect(start).not.toHaveBeenCalled();
});

it("finishes the snapshot update even when animation frames are suppressed", async () => {
  vi.useFakeTimers();
  const frame = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
  const { calls } = installTransition();
  const { result } = renderHook(useTheme);
  act(() => { result.current.change("dark"); });
  await act(async () => {
    const update = calls[0].update();
    await vi.runOnlyPendingTimersAsync();
    await update;
  });
  expect(frame).not.toHaveBeenCalled();
  expect(result.current.dark).toBe(true);
});

it("waits for menu close and a frame, and cancels superseded pending selections", () => {
  vi.useFakeTimers();
  const { calls, start } = installTransition();
  const { result } = renderHook(useTheme);
  act(() => { expect(result.current.change("dark", true)).toBe(true); });
  expect(localStorage.getItem("practiq-theme")).toBe("dark");
  act(() => { vi.advanceTimersByTime(100); });
  expect(start).not.toHaveBeenCalled();
  act(() => { result.current.applyPending(); result.current.change("light", true); });
  act(() => { vi.advanceTimersToNextFrame(); });
  expect(start).not.toHaveBeenCalled();
  act(() => { result.current.applyPending(); vi.advanceTimersToNextFrame(); });
  expect(result.current.theme).toBe("light");
  act(() => { result.current.change("dark", true); result.current.applyPending(); });
  expect(start).not.toHaveBeenCalled();
  act(() => { vi.advanceTimersToNextFrame(); });
  expect(calls).toHaveLength(1);
  act(() => { calls[0].update(); });
  expect(result.current.theme).toBe("dark");
});

it("keeps the latest selection when an older update or failure arrives late", async () => {
  const { calls } = installTransition();
  const { result } = renderHook(useTheme);
  act(() => { result.current.change("dark"); result.current.change("light"); });
  expect(calls[0].skip).toHaveBeenCalled();
  act(() => { result.current.change("dark"); });
  await act(async () => { calls[0].update(); calls[0].ready.reject(Error("Skipped")); calls[0].finished.resolve(); });
  expect(result.current.dark).toBe(false);
  expect(root.classList.contains("theme-transition")).toBe(true);
  act(() => { calls[1].update(); });
  expect(result.current.dark).toBe(true);
  expect(localStorage.getItem("practiq-theme")).toBe("dark");
});

it.each(["ready", "finished"] as const)("applies the saved theme when transition %s rejects", async failure => {
  const { calls } = installTransition();
  const { result } = renderHook(useTheme);
  act(() => { result.current.change("dark"); });
  await act(async () => { calls[0][failure].reject(Error("Capture failed")); });
  expect(result.current.dark).toBe(true);
  expect(root.style.colorScheme).toBe("dark");
  expect(root.classList.contains("theme-transition")).toBe(false);
  act(() => { calls[0].update(); });
  expect(result.current.theme).toBe("dark");
});

it("preserves a newer save error when an earlier successful selection commits", () => {
  const { calls } = installTransition();
  const { result } = renderHook(useTheme);
  act(() => { result.current.change("dark"); });
  const error = Error("Storage full");
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw error; });
  act(() => { expect(result.current.change("light")).toBe(false); });
  act(() => { void calls[0].update(); });
  expect(result.current.dark).toBe(true);
  expect(result.current.error).toBe(error);
  expect(localStorage.getItem("practiq-theme")).toBe("dark");
});

it("falls back if starting a transition throws", () => {
  const { start } = installTransition();
  start.mockImplementation(() => { throw Error("Unavailable"); });
  const { result } = renderHook(useTheme);
  act(() => { result.current.change("dark"); });
  expect(result.current.dark).toBe(true);
  expect(root.classList.contains("theme-transition")).toBe(false);
});

it("does not animate on save failure or leave callbacks alive after unmount", async () => {
  const { calls, start } = installTransition();
  const { result, unmount } = renderHook(useTheme);
  const save = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw Error("Full"); });
  act(() => { expect(result.current.change("dark", true)).toBe(false); result.current.applyPending(); });
  expect(start).not.toHaveBeenCalled();
  save.mockRestore();
  act(() => { result.current.change("dark"); });
  unmount();
  expect(calls[0].skip).toHaveBeenCalled();
  await act(async () => { calls[0].update(); calls[0].ready.reject(Error("Skipped")); });
  expect(root.style.colorScheme).toBe("light");
  expect(root.classList.contains("theme-transition")).toBe(false);
});
