import { parse } from "@babel/parser";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

// Product/technical names and the three self-identifying language choices are intentional.
const literalLabels = new Set(["PractiQ", "OpenAI", "DashScope", "DeepSeek", "Moonshot", "http://127.0.0.1:8000", "https://api.example.com/v1", "简体中文", "繁體中文", "English", "Free", "Plus", "Pro", "SHA-256：", "· Word / Excel ≤"]);
function untranslated(source: string) {
  const failures: string[] = [];
  const bindings = new Map<string, any>();
  const ast = parse(source, {sourceType:"module",plugins:["typescript","jsx"]});
  function check(value: string, line: number) {
    const text = value.trim();
    if (/\p{L}/u.test(text) && !literalLabels.has(text)) failures.push(`${line}: ${text}`);
  }
  function walk(node: unknown, visit: (node: Record<string, any>) => void) {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, any>;
    visit(n);
    for (const value of Object.values(n)) {
      if (Array.isArray(value)) value.forEach(value => walk(value, visit));
      else if (value && typeof value === "object") walk(value, visit);
    }
  }
  function bind(pattern: Record<string, any> | null, value: unknown) {
    if (!pattern) return;
    if (pattern.type === "Identifier") bindings.set(pattern.name, bindings.has(pattern.name) ? null : value);
    if (pattern.type === "AssignmentPattern") bind(pattern.left, null);
    if (pattern.type === "RestElement") bind(pattern.argument, null);
    if (pattern.type === "ObjectPattern") pattern.properties.forEach((p: any) => bind(p.type === "RestElement" ? p.argument : p.value, null));
    if (pattern.type === "ArrayPattern") pattern.elements.forEach((p: any) => bind(p, null));
  }
  walk(ast, n => {
    // ponytail: follow unique constants only; use scope resolution if shadowed copy needs auditing.
    if (n.type === "VariableDeclaration") n.declarations.forEach((d: any) => bind(d.id, n.kind === "const" ? d.init : null));
    n.params?.forEach((p: any) => bind(p, null));
    if (n.type === "CatchClause") bind(n.param, null);
  });
  function visible(n: Record<string, any> | null, seen = new Set<string>()) {
    if (!n) return;
    if (n.type === "StringLiteral") check(n.value, n.loc.start.line);
    if (n.type === "TemplateLiteral") { n.quasis.forEach((q: any) => check(q.value.cooked ?? q.value.raw, q.loc.start.line)); n.expressions.forEach((e: any) => visible(e, seen)); }
    if (n.type === "ConditionalExpression") { visible(n.consequent, seen); visible(n.alternate, seen); }
    if (n.type === "LogicalExpression" || n.type === "BinaryExpression" && n.operator === "+") { visible(n.left, seen); visible(n.right, seen); }
    if (["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression"].includes(n.type)) visible(n.expression, seen);
    if (n.type === "Identifier" && !seen.has(n.name)) visible(bindings.get(n.name), new Set([...seen, n.name]));
  }
  walk(ast, n => {
    if (n.type === "JSXText") check(n.value, n.loc.start.line);
    if (n.type === "JSXAttribute" && ["title", "placeholder", "aria-label", "alt"].includes(n.name.name)) visible(n.value?.type === "JSXExpressionContainer" ? n.value.expression : n.value);
    if (["JSXElement", "JSXFragment"].includes(n.type)) n.children.filter((child: any) => child.type === "JSXExpressionContainer").forEach((child: any) => visible(child.expression));
  });
  return failures;
}
it("rejects untranslated JSX text and accessible labels in either language", () => {
  expect(untranslated('<><p>未翻译</p><button aria-label="Delete"/><input placeholder="名称"/>{"Save"}</>')).toHaveLength(4);
  expect(untranslated('<button aria-label={t("删除")}>{t("保存")}</button>')).toEqual([]);
});
it("rejects visible conditional, template and constant copy without scanning content or technical props", () => {
  expect(untranslated('const title = "Untitled"; const X = () => <><button>{true ? "未翻译" : "Save"}</button><input placeholder={`Name`}/><p>{`Hello ${name}`}</p><p>{title}</p></>')).toHaveLength(5);
  expect(untranslated('<p>{`${"未翻译"}`}</p>')).toHaveLength(1);
  expect(untranslated('const className = "text-red-500"; const q = {stem:"原文"}; const X = () => <button className={className} aria-label={t("保存")}>{q.stem}{t("删除")}{value ? "English" : "简体中文"}</button>')).toEqual([]);
  expect(untranslated('const title = "Untitled"; const X = ({title}) => <p>{title}</p>; const Y = () => { let label = "A"; return <p>{label}</p>; }')).toEqual([]);
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
  scan('../shared/cloud');
  expect(failures).toEqual([]);
});
function nativeCalls(source: string) {
  const calls: {code: string; params: Set<string>; line: number}[] = [];
  const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
  const codes = (node: any): string[] => node?.type === "StringLiteral" ? (/^[A-Z][A-Z0-9_]+$/.test(node.value) ? [node.value] : [])
    : node?.type === "ConditionalExpression" ? [...codes(node.consequent), ...codes(node.alternate)]
    : node?.type === "LogicalExpression" ? [...codes(node.left), ...codes(node.right)] : [];
  function visit(node: any) {
    if (!node || typeof node !== "object") return;
    const invariant = node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "invariant";
    const constructor = node.type === "NewExpression" && node.callee.type === "Identifier" && node.callee.name === "AppError" || node.type === "CallExpression" && node.callee.type === "Super";
    if (invariant || constructor) {
      const parameters = node.arguments[invariant ? 3 : 2], params = new Set<string>();
      if (parameters?.type === "ObjectExpression") for (const property of parameters.properties) if (property.type === "ObjectProperty" && !property.computed) params.add(property.key.name ?? property.key.value);
      for (const code of codes(node.arguments[invariant ? 1 : 0])) calls.push({ code, params, line: node.loc.start.line });
    }
    for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === "object") visit(value);
  }
  // Computed provider/runtime codes remain opaque; concrete local outputs must be translated.
  visit(ast);
  return calls;
}
function nativeFailures(calls: ReturnType<typeof nativeCalls>, messages: Record<string,Record<string,string>>) {
  return calls.flatMap(call => {
    const pair = messages[call.code.split(':').at(-1)!];
    if (!pair) return [`${call.code}: missing translations`];
    const failures = ["en", "zh-CN"].filter(locale => !pair[locale]?.trim()).map(locale => `${call.code}: missing ${locale}`);
    const slots = new Set(Object.values(pair).flatMap(text => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1])));
    return [...failures, ...[...slots].filter(slot => !call.params.has(slot)).map(slot => `${call.code}: missing parameter ${slot}`)];
  });
}
it("collects native constructor outputs and interpolation parameters", () => {
  const calls = nativeCalls('new AppError("LOCAL_PATH", "Path", {key: reference.objectKey}); invariant(ready, "OFFICE_BUSY", "Busy"); new AppError(available ? "OFFICE_NOT_FOUND" : "OFFICE_CONVERSION_FAILED", "Failed"); const input = "LOCAL_UNUSED";');
  expect(calls.map(c => c.code)).toEqual(["LOCAL_PATH", "OFFICE_BUSY", "OFFICE_NOT_FOUND", "OFFICE_CONVERSION_FAILED"]);
  expect([...calls[0].params]).toEqual(["key"]);
  expect(nativeFailures(nativeCalls('new AppError("LOCAL_PATH", "Path", {});'), {LOCAL_PATH:{en:"Path {key}","zh-CN":"路径 {key}"}})).toEqual(["LOCAL_PATH: missing parameter key"]);
  expect(nativeCalls('invariant(false, "LOCAL_PATH", "Path", {diagnostic:{key:"nested"}, name:func("key: text")});')[0].params).toEqual(new Set(["diagnostic","name"]));
  expect(nativeCalls('class Pending extends AppError { constructor() { super("RESTORE_BUSY", "Pending"); } } new AppError(endpoint.code, endpoint.message);').map(c => c.code)).toEqual(["RESTORE_BUSY"]);
  expect(nativeCalls('// new AppError("LOCAL_UNUSED", "unused");\nconst text = `new AppError("LOCAL_UNUSED", "unused")`;')).toEqual([]);
});
it("ends every native error in terminal punctuation for all languages", async () => {
  const {default:messages} = await import("./locales/native.json");
  const failures = Object.entries(messages).flatMap(([code, pair]) => [
    ...(/[。！？…]$/u.test(pair["zh-CN"]) ? [] : [`${code}: zh-CN`]),
    ...(/[。！？…]$/u.test(pair["zh-TW"]) ? [] : [`${code}: zh-TW`]),
    ...(/[.!?…]$/u.test(pair.en) ? [] : [`${code}: en`]),
  ]);
  expect(failures).toEqual([]);
});
it("translates every native error into Traditional Chinese", async () => {
  const {default:messages} = await import("./locales/native.json");
  expect(Object.entries(messages).filter(([, pair]) => !pair["zh-TW"]?.trim()).map(([code]) => code)).toEqual([]);
});
it("translates native error outputs and supplies their interpolation parameters", async () => {
  const {default:messages} = await import("./locales/native.json");
  const { en } = await import("./locales/en");
  const mapped = Object.fromEntries([...readFileSync('src/api.ts','utf8').matchAll(/([A-Z_]+): t\("([^"]+)"\)/g)].map(([,code,key]) => [code,{en:en[key as keyof typeof en],"zh-CN":key}]));
  const calls: ReturnType<typeof nativeCalls> = [];
  for (const file of readdirSync('desktop').filter(f=>/\.(?:ts|cts)$/.test(f) && !f.endsWith('.test.ts'))) {
    calls.push(...nativeCalls(readFileSync(join('desktop',file),'utf8')).map(c => ({...c, code:`${file}:${c.line}:${c.code}`})));
  }
  expect(calls.length).toBeGreaterThan(0);
  expect(nativeFailures(calls, {...mapped,...messages})).toEqual([]);
});
