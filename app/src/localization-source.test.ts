import { parse } from "@babel/parser";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

// Product/technical names and the two self-identifying language choices are intentional.
const literalLabels = new Set(["PractiQ", "API Key", "Base URL", "https://api.example.com/v1", "OSS URL", "简体中文", "English"]);
function untranslated(source: string) {
  const failures: string[] = [];
  function check(value: string, line: number) {
    const text = value.trim();
    if (/\p{L}/u.test(text) && !literalLabels.has(text)) failures.push(`${line}: ${text}`);
  }
  function walk(node: unknown) {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, any>;
    if (n.type === "JSXText") check(n.value, n.loc.start.line);
    if (n.type === "JSXAttribute" && ["title", "placeholder", "aria-label", "alt"].includes(n.name.name) && n.value?.type === "StringLiteral") check(n.value.value,n.loc.start.line);
    if (n.type === "JSXExpressionContainer" && n.expression.type === "StringLiteral") check(n.expression.value,n.loc.start.line);
    for (const value of Object.values(n)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") walk(value);
    }
  }
  walk(parse(source, {sourceType:"module",plugins:["typescript","jsx"]}));
  return failures;
}
it("rejects untranslated JSX text and accessible labels in either language", () => {
  expect(untranslated('<><p>未翻译</p><button aria-label="Delete"/><input placeholder="名称"/>{"Save"}</>')).toHaveLength(4);
  expect(untranslated('<button aria-label={t("删除")}>{t("保存")}</button>')).toEqual([]);
});
it("routes application JSX copy and accessible labels through the dictionary", () => {
  const failures: string[] = [];
  function scan(directory: string) {
    for (const entry of readdirSync(directory,{withFileTypes:true})) {
      const path = join(directory,entry.name);
      if (entry.isDirectory()) scan(path);
      else if (entry.name.endsWith('.tsx') && !entry.name.includes('.test.')) failures.push(...untranslated(readFileSync(path,'utf8')).map(s=>`${path}:${s}`));
    }
  }
  scan('src');
  expect(failures).toEqual([]);
});
it("translates every local error code emitted by Rust", async () => {
  const {default:messages} = await import("./locales/native.json");
  const { en } = await import("./locales/en");
  const { zhCN } = await import("./locales/zh-CN");
  const mapped = Object.fromEntries([...readFileSync('src/api.ts','utf8').matchAll(/([A-Z_]+): t\("([^"]+)"\)/g)].map(([,code,key]) => [code,{en:en[key as keyof typeof en],"zh-CN":zhCN[key as keyof typeof zhCN]}]));
  const codes = new Set<string>();
  for (const file of readdirSync('src-tauri/src').filter(f=>f.endsWith('.rs'))) {
    for (const match of readFileSync(join('src-tauri/src',file),'utf8').matchAll(/"(LOCAL_[A-Z_]+)"/g)) codes.add(match[1]);
  }
  expect(codes.size).toBeGreaterThan(0);
  for (const code of codes) {
    const pair = (messages as Record<string,Record<string,string>>)[code] ?? mapped[code];
    expect(pair,code).toBeDefined();
    expect(pair.en?.trim(),code).toBeTruthy();
    expect(pair['zh-CN']?.trim(),code).toBeTruthy();
  }
});
