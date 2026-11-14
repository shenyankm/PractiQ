import assert from "node:assert/strict";
import { parse } from "@babel/parser";
import type { Node } from "@babel/types";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

function moduleNames(source: string): string[] {
  const imports: string[] = [];
  const isNode = (value: unknown): value is Node => value !== null && typeof value === "object" && "type" in value && typeof value.type === "string";
  const visit = (node: Node) => {
    if ((node.type === "ImportDeclaration" || node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration" || node.type === "ImportExpression") && node.source?.type === "StringLiteral") imports.push(node.source.value);
    if (node.type === "CallExpression" && node.arguments[0]?.type === "StringLiteral") {
      const call = node.callee, require = call.type === "Identifier" && call.name === "require", resolve = call.type === "MemberExpression" && !call.computed && call.property.type === "Identifier" && call.property.name === "resolve" && call.object.type === "MetaProperty" && call.object.meta.name === "import" && call.object.property.name === "meta";
      if (require || resolve || call.type === "Import") imports.push(node.arguments[0].value);
    }
    for (const value of Object.values(node)) if (Array.isArray(value)) value.filter(isNode).forEach(visit); else if (isNode(value)) visit(value);
  };
  visit(parse(source, { sourceType: "module" })); return imports;
}
export function runtimeDependencies(root: string, project: Record<string, any>) {
  const directory = join(root, ".build/electron"), desktop = join(directory, "app/desktop"), pending = readdirSync(desktop).filter(name => name.endsWith(".js") && !["build.js", "vitest.config.js"].includes(name)).map(name => join(desktop, name)), seen = new Set<string>(), packages = new Set<string>();
  while (pending.length) {
    const path = pending.pop()!; if (seen.has(path)) continue; seen.add(path);
    for (const name of moduleNames(readFileSync(path, "utf8"))) {
      if (name.startsWith(".")) { const local = resolve(dirname(path), name); assert.ok(local.startsWith(`${directory}/`) && existsSync(local), "Compiled dependency is missing or outside the runtime"); if (local.endsWith(".js")) pending.push(local); }
      else if (!name.startsWith("node:") && name !== "electron") packages.add(name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : name.split("/")[0]);
    }
  }
  return Object.fromEntries([...packages].sort().map(name => { assert.ok(project.dependencies[name], `Declare runtime dependency ${name}`); return [name, project.dependencies[name]]; }));
}
export function optionalOtherPlatform(locked: Record<string, any>, architecture: string): boolean {
  assert.ok(["arm64", "x64"].includes(architecture));
  const supports = (values: unknown, target: string) => { if (values === undefined) return true; assert.ok(Array.isArray(values) && values.every(value => typeof value === "string")); return !values.includes(`!${target}`) && (!values.some(value => !value.startsWith("!")) || values.includes(target) || values.includes("any")); };
  const os = supports(locked.os, "darwin"), cpu = supports(locked.cpu, architecture); return locked.optional === true && (!os || !cpu);
}
export function auditPackage(bundle: string) {
  assert.ok(lstatSync(bundle).isDirectory() && !lstatSync(bundle).isSymbolicLink(), "Package root must be a real directory");
  function audit(directory: string): number {
    let files = 0;
    for (const name of readdirSync(directory)) {
      const path = join(directory, name), stat = lstatSync(path);
      assert.ok(!/^(?:(?:lib)?python(?:[0-9._-].*)?|soffice(?:\.exe)?|libreoffice(?:\.app)?|postgres(?:ql|\.exe)?|pg_ctl|rabbitmq(?:-server)?|erl|practiq-ai(?:\.exe)?|base_library\.zip)$/i.test(name) && !/\.(?:py|pyc|pyo|rs)$/i.test(name) && !/^\.env(?:\.|$)/i.test(name), `Forbidden legacy runtime or environment file: ${relative(bundle, path)}`);
      if (stat.isSymbolicLink()) { assert.ok(!isAbsolute(readlinkSync(path)) && realpathSync(path).startsWith(`${realpathSync(bundle)}/`), "Package link escapes the app bundle"); continue; }
      if (stat.isDirectory()) files += audit(path);
      else { assert.ok(stat.isFile(), "Unsupported package file type"); files++; }
    }
    return files;
  }
  return audit(bundle);
}
