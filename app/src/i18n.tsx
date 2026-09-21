import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { en } from "./locales/en";
import { zhCN } from "./locales/zh-CN";

export type Locale = "zh-CN" | "en";
export type LanguageRequest = { type: "language" } | { type: "save_language"; locale: Locale };
export type MessageKey = keyof typeof en;
type Slots<S extends string> = S extends `${string}{${infer P}}${infer Rest}` ? P | Slots<Rest> : never;
export type Value = string | number | boolean | null | undefined;
type Args<K extends MessageKey> = [Slots<K>] extends [never] ? [] : [params: Record<Slots<K>, Value>];
export function systemLocale(languages: readonly string[]): Locale {
  return languages[0]?.toLowerCase().split("-")[0] === "zh" ? "zh-CN" : "en";
}
export function isLocale(value: unknown): value is Locale { return value === "zh-CN" || value === "en"; }
// One desktop window owns the locale. Async callbacks read the current language,
// rather than retaining the language in which a request was started.
let current: Locale = systemLocale(typeof navigator === "undefined" ? [] : navigator.languages);
export function locale() { return current; }
export function list(values: string[]) { return new Intl.ListFormat(current, { style: "short", type: "conjunction" }).format(values); }
export function number(value: number, digits?: number) {
  return new Intl.NumberFormat(current, digits == null ? undefined : { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}
export function translate<K extends MessageKey>(language: Locale, key: K, ...args: Args<K>): string {
  const params = (args[0] ?? {}) as Record<string, Value>;
  let template: string = language === "en" ? en[key] : zhCN[key];
  // Counts in these messages are immediately followed by their English noun.
  if (language === "en") template = template.replace(/\{(\d+)\} (questions|banks|images|resources|calls|points)\b/g,
    (text, slot: string, noun: string) => typeof params[slot] === "number" && new Intl.PluralRules(language).select(params[slot] as number) === "one" ? `{${slot}} ${noun.slice(0, -1)}` : text);
  return template.replace(/\{(\d+)\}/g, (_, slot: string) => {
    const value = params[slot];
    return typeof value === "number" ? new Intl.NumberFormat(language).format(value) : value == null || value === false ? "" : String(value);
  });
}
export function t<K extends MessageKey>(key: K, ...args: Args<K>) { return translate(current, key, ...args); }
export type Message = { key: MessageKey; params?: Record<string, Value> };
export function message<K extends MessageKey>(key: K, ...args: Args<K>): Message { return { key, params: args[0] }; }
export function renderMessage(value: Message): string {
  return translate(current, value.key, value.params as never);
}
export class MessageError extends Error {
  constructor(readonly localized: Message) { super(localized.key); }
}

type LanguageFailure = { key: "读取语言设置失败" | "保存语言设置失败"; cause: unknown };
type LanguageContext = { locale: Locale; ready: boolean; saving: boolean; error: LanguageFailure | null; reload: () => Promise<void>; change: (value: Locale) => Promise<void> };
const Context = createContext<LanguageContext>({ locale: current, ready: true, saving: false, error: null, reload: async () => {}, change: async () => {} });
export function useI18n() { return useContext(Context); }
export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState(current);
  const [ready, setReady] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState<LanguageFailure | null>(null);
  const lock = useRef(false);
  const generation = useRef(0);
  function apply(value: Locale) { current = value; document.documentElement.lang = value; setLanguage(value); }
  async function reload() {
    if (lock.current) return;
    const request = ++generation.current;
    try {
      const saved = await invoke<Locale | null>("request", { request: { type: "language" } satisfies LanguageRequest });
      if (request !== generation.current) return;
      apply(isLocale(saved) ? saved : systemLocale(navigator.languages));
      setError(null);
    } catch (e) { if (request === generation.current) setError({ key: "读取语言设置失败", cause: e }); }
    finally { if (request === generation.current) setReady(true); }
  }
  useEffect(() => { document.documentElement.lang = current; void reload(); return () => { ++generation.current; }; }, []);
  async function change(value: Locale) {
    if (!isLocale(value) || lock.current || !ready) return;
    const request = ++generation.current;
    lock.current = true; setSaving(true);
    try {
      await invoke("request", { request: { type: "save_language", locale: value } satisfies LanguageRequest });
      if (request !== generation.current) return;
      apply(value); setError(null);
    } catch (e) { if (request === generation.current) setError({ key: "保存语言设置失败", cause: e }); }
    finally { lock.current = false; if (request === generation.current) setSaving(false); }
  }
  return <Context.Provider value={{ locale: language, ready, saving, error, reload, change }}>{ready ? children : <p role="status">{t("正在读取语言设置…")}</p>}</Context.Provider>;
}
