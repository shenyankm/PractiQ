import { useSyncExternalStore } from "react";
import en from "./locales/en.json";
import zhTW from "./locales/zh-TW.json";
export type CloudLocale = "zh-CN" | "zh-TW" | "en";
let current: CloudLocale = "zh-CN";
const listeners = new Set<() => void>();
export function setCloudLocale(value: CloudLocale) {
  if (current === value) return;
  current = value;
  listeners.forEach(listener => listener());
}
export function cloudLocale() { return current; }
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function useCloudLocale() { return useSyncExternalStore(subscribe, cloudLocale, cloudLocale); }
export function t(key: string, ...values: unknown[]): string {
  const trimmed = key.trim();
  const messages: Record<string, string> = current === "en" ? en : zhTW;
  const template = current === "zh-CN" ? key : (key.match(/^\s*/)?.[0] ?? "") + (messages[trimmed] ?? trimmed) + (key.match(/\s*$/)?.[0] ?? "");
  return template.replace(/\{(\d+)\}/g, (_, index: string) => String(values[Number(index)] ?? ""));
}
