import { appendFileSync, readFileSync } from "node:fs";
import { matchesGlob, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export type Scope = "service" | "desktop";
type Run = (command: string, args: string[], allowFailure?: boolean) => { status: number; stdout: Buffer };
const documentation = ["README*.md", "CONTRIBUTING.md", "SECURITY.md", "AGENTS.md", "CODE_OF_CONDUCT.md", "docs/**", "app/docs/**", "server/docs/**", ".agents/**", ".github/PULL_REQUEST_TEMPLATE.md", ".github/ISSUE_TEMPLATE/**", ".github/labels.json", "app/licenses/README.md", "app/fixtures/ai-import/README.md", "app/fixtures/office/README.md", "app/fixtures/rich-content/README.md"];
const sha = /^[0-9a-f]{40}$/;
function scope(value: unknown): asserts value is Scope {
  if (value !== "service" && value !== "desktop") throw Error("Unsupported CI scope");
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Expected CI metadata object");
  return value as Record<string, unknown>;
}
function path(value: unknown): string {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.includes("\0") || value.split("/").some(part => part === "." || part === "..")) throw Error("Invalid changed path");
  return value;
}
const run: Run = (command, args, allowFailure = false) => {
  const result = spawnSync(command, args, { timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status === null || !allowFailure && result.status !== 0) throw Error(`CI command failed: ${command}`);
  return { status: result.status, stdout: result.stdout };
};
export function checksRequired(target: Scope, paths: string[] | null): boolean {
  scope(target);
  // Every non-documentation input checks both embedded AI and desktop packaging.
  return paths === null || paths.some(value => !documentation.some(pattern => matchesGlob(path(value), pattern)));
}
export function changedPaths(event: string, payload: unknown, repository: string, execute: Run = run): string[] | null {
  if (event === "workflow_dispatch") return null;
  const data = object(payload);
  if (event === "pull_request") {
    if (!Number.isSafeInteger(data.number) || Number(data.number) < 1 || !/^[\w.-]+\/[\w.-]+$/.test(repository)) throw Error("Invalid pull request identity");
    const pages: unknown = JSON.parse(execute("gh", ["api", "--paginate", "--slurp", `repos/${repository}/pulls/${data.number}/files?per_page=100`]).stdout.toString("utf8"));
    if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) throw Error("Invalid changed-files response");
    const files = pages.flat();
    if (files.length >= 3000) return null;
    return files.flatMap(value => { const entry = object(value); return [path(entry.filename), ...(entry.previous_filename == null ? [] : [path(entry.previous_filename)])]; });
  }
  if (event !== "push") throw Error("Unsupported CI event");
  const before = data.before;
  if (typeof before !== "string" || !sha.test(before) || before === "0".repeat(40)) return null;
  if (execute("git", ["cat-file", "-e", `${before}^{commit}`], true).status !== 0 && execute("git", ["fetch", "--no-tags", "--depth=1", "origin", before], true).status !== 0) return null;
  const result = execute("git", ["diff", "--name-only", "--no-renames", "-z", before, "HEAD"]).stdout;
  return new TextDecoder("utf-8", { fatal: true }).decode(result).split("\0").filter(Boolean).map(path);
}
export function checkGate(target: Scope, input: unknown): void {
  scope(target);
  const needs = object(input), jobs = target === "desktop" ? ["changes", "quality", "package"] : ["changes", "quality"];
  if (Object.keys(needs).sort().join() !== [...jobs].sort().join()) throw Error("Missing or unexpected CI dependencies");
  const changes = object(needs.changes), outputs = object(changes.outputs);
  if (changes.result !== "success") throw Error("Change detection did not succeed");
  if (typeof outputs.sha !== "string" || !sha.test(outputs.sha)) throw Error("Source revision is missing or invalid");
  if (outputs.required !== "true" && outputs.required !== "false") throw Error("Change detection did not report required=true or false");
  const expected = outputs.required === "true" ? "success" : "skipped";
  for (const job of jobs.slice(1)) if (object(needs[job]).result !== expected) throw Error(`${job} did not report ${expected}`);
}
export function main(args = process.argv.slice(2), environment = process.env): number {
  try {
    const [command, target] = args; scope(target);
    if (args.length !== 2) throw Error("Use scope|gate service|desktop");
    if (command === "gate") { checkGate(target, JSON.parse(environment.NEEDS ?? "")); console.log(`${target} CI passed`); }
    else if (command === "scope") {
      if (!environment.GITHUB_EVENT_PATH || !environment.GITHUB_OUTPUT) throw Error("Missing Actions event or output path");
      const payload = JSON.parse(readFileSync(environment.GITHUB_EVENT_PATH, "utf8"));
      const paths = environment.CI_FULL_CHECKS === "true" ? null : changedPaths(environment.GITHUB_EVENT_NAME ?? "", payload, environment.GITHUB_REPOSITORY ?? "");
      const output = `required=${checksRequired(target, paths)}\n`;
      appendFileSync(environment.GITHUB_OUTPUT, output); process.stdout.write(output);
    } else throw Error("Unsupported CI command");
    return 0;
  } catch (error) { console.error(`CI decision failed: ${error instanceof Error ? error.message : "Invalid metadata"}`); return 1; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
