import { useEffect, useState } from "react";

export type Theme = "system" | "light" | "dark";
const key = "practiq-theme";
function readTheme(): Theme {
  const value = localStorage.getItem(key);
  return value === "light" || value === "dark" ? value : "system";
}
export function useTheme() {
  const [error, setError] = useState<unknown>(null);
  const [theme, setTheme] = useState<Theme>("system");
  const [dark, setDark] = useState(false);
  useEffect(() => {
    try { setTheme(readTheme()); } catch (e) { setError(e); }
  }, []);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const value = theme === "dark" || (theme === "system" && media.matches);
      document.documentElement.classList.toggle("dark", value);
      document.documentElement.style.colorScheme = value ? "dark" : "light";
      setDark(value);
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  function change(value: Theme) {
    try {
      localStorage.setItem(key, value);
      setTheme(value); setError(null); return true;
    } catch (e) { setError(e); return false; }
  }
  return { theme, dark, error, change };
}
