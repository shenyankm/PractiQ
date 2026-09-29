import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

type Theme = "system" | "light" | "dark";
const key = "practiq-theme";
const systemQuery = "(prefers-color-scheme: dark)";
export type ThemeState = { theme: Theme; systemDark: boolean; error: unknown };

function readTheme(): ThemeState {
  const state: ThemeState = { theme: "system", systemDark: window.matchMedia(systemQuery).matches, error: null };
  try {
    const value = localStorage.getItem(key);
    if (value === "light" || value === "dark") state.theme = value;
  } catch (error) { state.error = error; }
  return state;
}

function isDark({ theme, systemDark }: ThemeState) {
  return theme === "dark" || (theme === "system" && systemDark);
}

function applyTheme(dark: boolean) {
  const root = document.documentElement;
  if (root.classList.contains("dark") === dark && root.style.colorScheme === (dark ? "dark" : "light")) return;
  root.classList.add("theme-changing");
  root.classList.toggle("dark", dark);
  root.style.colorScheme = dark ? "dark" : "light";
  // Resolve the new colors with component transitions disabled before restoring them.
  void root.offsetHeight;
  root.classList.remove("theme-changing");
}

export function initializeTheme() {
  const state = readTheme();
  applyTheme(isDark(state));
  return state;
}

export function useTheme(initial?: ThemeState) {
  const [state, setState] = useState(() => initial ?? readTheme());
  const cancel = useRef<() => void>(() => {});
  const pending = useRef<(() => void) | null>(null);
  const dark = isDark(state);
  useLayoutEffect(() => { applyTheme(dark); }, [dark]);
  useEffect(() => {
    if (state.theme !== "system") return;
    const media = window.matchMedia(systemQuery);
    const update = () => setState(previous => previous.systemDark === media.matches ? previous : { ...previous, systemDark: media.matches });
    media.addEventListener("change", update);
    update();
    return () => media.removeEventListener("change", update);
  }, [state.theme]);
  useEffect(() => () => { cancel.current(); pending.current = null; }, []);

  function change(value: Theme, deferUntilClose = false) {
    try { localStorage.setItem(key, value); }
    catch (error) { setState(previous => ({ ...previous, error })); return false; }

    setState(previous => previous.error === null ? previous : { ...previous, error: null });
    cancel.current();
    let active = true;
    let committed = false;
    let frame: number | undefined;
    let transition: ViewTransition | undefined;
    const root = document.documentElement;
    const cleanup = () => { if (active) root.classList.remove("theme-transition"); };
    cancel.current = () => {
      active = false;
      if (frame !== undefined) cancelAnimationFrame(frame);
      transition?.skipTransition();
      root.classList.remove("theme-transition");
    };
    const update = () => {
      if (!active || committed) return;
      committed = true;
      const systemDark = window.matchMedia(systemQuery).matches;
      flushSync(() => setState(previous => ({ ...previous, theme: value, systemDark })));
    };
    const run = () => {
      if (!active) return;
      const nextDark = value === "dark" || (value === "system" && window.matchMedia(systemQuery).matches);
      if (nextDark === root.classList.contains("dark") || !document.startViewTransition || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        update();
        return;
      }
      root.classList.add("theme-transition");
      const fallback = () => { if (active) { transition?.skipTransition(); update(); cleanup(); } };
      try {
        transition = document.startViewTransition(async () => {
          update();
          // Let Sonner's effect commit too. rAF is suppressed while a view transition captures.
          await new Promise<void>(resolve => setTimeout(resolve, 0));
        });
        void transition.ready.catch(fallback);
        void transition.finished.then(cleanup, fallback);
      } catch { fallback(); }
    };
    // Radix restores focus after its exit animation. One frame leaves its teardown before capture.
    pending.current = deferUntilClose ? () => { frame = requestAnimationFrame(run); } : null;
    if (!deferUntilClose) run();
    return true;
  }

  function applyPending() {
    const run = pending.current;
    pending.current = null;
    run?.();
  }
  return { theme: state.theme, dark, error: state.error, change, applyPending };
}
