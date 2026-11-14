import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { changedPaths, checkGate, checksRequired, type Scope } from "./ci-scope.ts";

const script = fileURLToPath(new URL("./ci-scope.ts", import.meta.url));
const scopes: Scope[] = ["service", "desktop"];
function temporary(action: (directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), "practiq-ci-scope-"));
  try { action(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}
function needs(target: Scope, required = true): Record<string, any> {
  const result = required ? "success" : "skipped";
  return { changes: { result: "success", outputs: { required: String(required), sha: "a".repeat(40) } }, quality: { result }, ...(target === "desktop" ? { package: { result } } : {}) };
}

test("only recognized documentation skips both embedded-runtime gates", () => {
  for (const target of scopes) {
    assert.equal(checksRequired(target, null), true);
    assert.equal(checksRequired(target, []), false);
    for (const value of ["README.md", "README.zh-TW.md", "CONTRIBUTING.md", "AGENTS.md", "docs/guide.md", "app/docs/guide.md", "server/docs/history.md", "app/licenses/README.md", ".github/ISSUE_TEMPLATE/bug.yml", ".github/PULL_REQUEST_TEMPLATE.md"]) assert.equal(checksRequired(target, [value]), false, value);
    for (const value of ["app/desktop/main.ts", "app/src/App.tsx", "shared/ai-contracts.json", "app/package-lock.json", "app/licenses/texts/notice.md", "app/fixtures/source.md", ".github/scripts/ci-scope.ts", ".github/workflows/release.yml", "Makefile", ".gitignore", "LICENSE", "server/src/old.py", "unknown/new-build-tool.ts"]) assert.equal(checksRequired(target, ["docs/guide.md", value]), true, value);
    assert.equal(checksRequired(target, ["README.ts"]), true);
    assert.throws(() => checksRequired(target, ["docs/../app/desktop/main.ts"]));
    assert.throws(() => checksRequired(target, ["/README.md"]));
  }
});

test("PR selection includes every page and both sides of a rename", () => {
  const calls: string[][] = [];
  const paths = changedPaths("pull_request", { number: 17 }, "owner/repo", (command, args) => {
    calls.push([command, ...args]);
    return { status: 0, stdout: Buffer.from(JSON.stringify([[{ filename: "README.md" }], [{ filename: "docs/renamed.md", previous_filename: "app/desktop/worker.ts" }]])) };
  });
  assert.deepEqual(calls, [["gh", "api", "--paginate", "--slurp", "repos/owner/repo/pulls/17/files?per_page=100"]]);
  assert.deepEqual(paths, ["README.md", "docs/renamed.md", "app/desktop/worker.ts"]);
  assert.equal(checksRequired("service", paths), true);
});
for (const count of [2999, 3000]) test(`PR ${count}-file response handles the API truncation limit`, () => {
  const pages = [Array.from({ length: count }, (_, index) => ({ filename: `docs/${index}.md` }))];
  const paths = changedPaths("pull_request", { number: 17 }, "owner/repo", () => ({ status: 0, stdout: Buffer.from(JSON.stringify(pages)) }));
  assert.equal(paths === null, count === 3000);
  assert.equal(checksRequired("desktop", paths), count === 3000);
});

test("malformed metadata and failed API calls cannot become documentation skips", () => {
  for (const response of [{}, [null], [[{ filename: null }]], [[{ filename: "README.md", previous_filename: "../bad" }]]]) assert.throws(() => changedPaths("pull_request", { number: 17 }, "owner/repo", () => ({ status: 0, stdout: Buffer.from(JSON.stringify(response)) })));
  assert.throws(() => changedPaths("pull_request", { number: 17 }, "owner/repo", () => { throw Error("API unavailable"); }));
  assert.throws(() => changedPaths("pull_request", { number: "17" }, "owner/repo"));
  assert.throws(() => changedPaths("pull_request", { number: 17 }, "../owner/repo"));
  assert.throws(() => changedPaths("schedule", {}, "owner/repo"));
});

test("missing push bases require full checks and unavailable commits are fetched without tags", () => {
  for (const before of [undefined, "", "main", "0".repeat(40), "f".repeat(40)]) {
    const calls: string[][] = [];
    const paths = changedPaths("push", { before }, "owner/repo", (command, args, allowFailure) => { assert.equal(allowFailure, true); calls.push([command, ...args]); return { status: 1, stdout: Buffer.alloc(0) }; });
    assert.equal(paths, null); assert.equal(calls.length, before === "f".repeat(40) ? 2 : 0);
    if (calls.length) assert.deepEqual(calls[1], ["git", "fetch", "--no-tags", "--depth=1", "origin", before]);
  }
  const commands: string[][] = [];
  assert.deepEqual(changedPaths("push", { before: "a".repeat(40) }, "owner/repo", (_command, args) => {
    commands.push(args); return { status: args[0] === "cat-file" ? 1 : 0, stdout: Buffer.from(args[0] === "diff" ? "app/desktop/main.ts\0" : "") };
  }), ["app/desktop/main.ts"]);
  assert.equal(commands[2][0], "diff");
});

test("real multi-commit push retains deleted inputs and Unicode paths with NUL separation", () => temporary(directory => {
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=CI test", "-c", "user.email=ci@example.test", "-c", "commit.gpgSign=false", "-c", `core.hooksPath=${join(directory, "no-hooks")}`, ...args], { cwd: directory, encoding: "utf8" }).trim();
  git("init", "--quiet"); mkdirSync(join(directory, "app")); writeFileSync(join(directory, "app/runtime.ts"), "source\n"); git("add", "."); git("commit", "-qm", "Before push"); const before = git("rev-parse", "HEAD");
  mkdirSync(join(directory, "docs")); renameSync(join(directory, "app/runtime.ts"), join(directory, "docs/已移动 source.md")); git("add", "-A"); git("commit", "-qm", "Move runtime into documentation");
  writeFileSync(join(directory, "README.md"), "Only latest commit is documentation\n"); git("add", "."); git("commit", "-qm", "Readme");
  const event = join(directory, "event.json"), output = join(directory, "output"); writeFileSync(event, JSON.stringify({ before }));
  const result = spawnSync(process.execPath, [script, "scope", "desktop"], { cwd: directory, env: { ...process.env, GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: output, GITHUB_REPOSITORY: "owner/repo", CI_FULL_CHECKS: "false" }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr); assert.equal(readFileSync(output, "utf8"), "required=true\n");
}));

for (const target of scopes) for (const required of [true, false]) test(`${target} gate accepts only its exact ${required ? "successful" : "deliberately skipped"} dependencies`, () => {
  checkGate(target, needs(target, required));
  for (const job of ["quality", ...(target === "desktop" ? ["package"] : [])]) for (const result of ["success", "skipped", "cancelled", "failure", "neutral", undefined]) {
    if (result === (required ? "success" : "skipped")) continue;
    const value = needs(target, required); value[job].result = result; assert.throws(() => checkGate(target, value));
  }
  for (const revision of [undefined, "", "main", "a".repeat(39), "A".repeat(40)]) { const value = needs(target, required); value.changes.outputs.sha = revision; assert.throws(() => checkGate(target, value), /revision/); }
  for (const result of [undefined, "skipped", "cancelled", "failure"]) { const value = needs(target, required); value.changes.result = result; assert.throws(() => checkGate(target, value)); }
  for (const flag of [undefined, "unknown", true, false]) { const value = needs(target, required); value.changes.outputs.required = flag; assert.throws(() => checkGate(target, value)); }
  const missing = needs(target, required); delete missing.quality; assert.throws(() => checkGate(target, missing));
  assert.throws(() => checkGate(target, { ...needs(target, required), unexpected: { result: "success" } }));
});

test("CLI propagates failed gates and preserves deliberate skips", () => {
  for (const target of scopes) for (const required of [true, false]) {
    const value = needs(target, required);
    const invoke = () => spawnSync(process.execPath, [script, "gate", target], { env: { ...process.env, NEEDS: JSON.stringify(value) }, encoding: "utf8" });
    assert.equal(invoke().status, 0); value.quality.result = "cancelled"; assert.equal(invoke().status, 1);
  }
  assert.equal(spawnSync(process.execPath, [script, "gate", "unknown"]).status, 1);
});
test("manual and pinned-ref workflows require full checks without querying a PR", () => temporary(directory => {
  const event = join(directory, "event.json"), output = join(directory, "output"); writeFileSync(event, "{}");
  for (const target of scopes) for (const [eventName, full] of [["workflow_dispatch", "false"], ["pull_request", "true"]]) {
    writeFileSync(output, "existing-output=preserved\n");
    const result = spawnSync(process.execPath, [script, "scope", target], { env: { ...process.env, GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: output, GITHUB_REPOSITORY: "owner/repo", CI_FULL_CHECKS: full }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr); assert.equal(readFileSync(output, "utf8"), "existing-output=preserved\nrequired=true\n");
  }
}));
