import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import React from "react";
const { renderToStaticMarkup } = require("react-dom/server") as { renderToStaticMarkup(node: React.ReactNode): string };
import { feedbackVisible, correctnessLabel } from "../src/api/answer-visibility";
import type { PracticeSession, QuestionRecord } from "../src/api/modules";

const source = (name: string) => readFileSync(path.resolve(__dirname, "../src", name), "utf8");

test("answer visibility has no owner override, no-session answers stay hidden, abandoned exam never unlocks", () => {
  assert.equal(feedbackVisible(null, true), false);
  for (const mode of ["all", "wrong", "by_type", "exam"]) {
    for (const status of ["active", "abandoned", "completed"]) {
      const session: PracticeSession = { id: 1, bank_id: 2, mode, session_type: mode === "exam" ? "exam" : "practice", status };
      assert.equal(feedbackVisible(session, true), mode !== "exam" || status === "completed");
      assert.equal(feedbackVisible(session, false), mode === "exam" && status === "completed");
    }
  }
  assert.equal(correctnessLabel(undefined), "待公布"); assert.equal(correctnessLabel(null), "待公布"); assert.equal(correctnessLabel(false), "错误");
});

test("actual QuestionContent renders no hidden analysis; HTML cannot initiate external resource loads", () => {
  const module = { exports: {} };
  const js = ts.transpileModule(source("components/QuestionContent.tsx"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  new Function("require", "module", "exports", js)((id: string) => {
    if (id === "@tarojs/components") return { View: "div", Text: "span" };
    if (id === "./ProtectedImage") return { ProtectedImage: () => React.createElement("span", null, "verified-image-only") };
    if (id === "react/jsx-runtime") return require("react/jsx-runtime") as unknown;
    throw new Error(`Unexpected import ${id}`);
  }, module, module.exports);
  const { QuestionContent } = module.exports as { QuestionContent: React.ComponentType<{ question: Partial<QuestionRecord>; revealAnswer?: boolean }> };
  const question = { stem: "stem", analysis: "secret-answer", can_edit: true, options: [{ option_label: "A", content: "choice", is_correct: true }], content_blocks: [{ part_type: "html", sequence: 1, payload: { html: '<img src="https://evil.test/track" />' } }] };
  const hidden = renderToStaticMarkup(React.createElement(QuestionContent, { question }));
  assert.ok(!hidden.includes("secret-answer")); assert.ok(!hidden.includes("answer-option-active")); assert.ok(!hidden.includes("<img")); assert.ok(hidden.includes("&lt;img"));
  const shown = renderToStaticMarkup(React.createElement(QuestionContent, { question, revealAnswer: true })); assert.ok(shown.includes("secret-answer"));
});

test("all registered business routes export the protection boundary and learning/detail never selects management", () => {
  const exports: { default?: { pages: string[]; subpackages: Array<{ root: string; pages: string[] }> } } = {};
  const js = ts.transpileModule(source("app.config.ts"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  new Function("defineAppConfig", "exports", js)((value: unknown) => value, exports);
  const config = exports.default!;
  const routes = [...config.pages, ...config.subpackages.flatMap((group) => group.pages.map((page) => `${group.root}/${page}`))].filter((route) => !["pages/login/index", "pages/privacy/index"].includes(route));
  assert.equal(routes.length, 23);
  for (const route of routes) assert.match(source(`${route}.tsx`), /export default protectedPage\(/, route);
  assert.match(source("packages/content/questions/edit/index.tsx"), /api\.questions\.management\(id\)/);
  assert.match(source("packages/content/questions/detail/index.tsx"), /revealAnswer=\{false\}/);
  assert.doesNotMatch(source("packages/content/questions/detail/index.tsx"), /questions\.management/);
  assert.doesNotMatch(source("pages/home/index.tsx"), /cachedForUser/);
});
