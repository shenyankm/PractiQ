import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import desktopConfig from "../../app/desktop/vitest.config.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const yaml = createRequire(new URL("../../app/package.json", import.meta.url))("js-yaml") as { load(input: string): unknown };
function workflow(name: string): Record<string, any> {
  return yaml.load(readFileSync(join(root, `.github/workflows/${name}.yml`), "utf8")) as Record<string, any>;
}
const source = "${{ inputs.ref || github.sha }}";
const templates = [{ name: "app", scope: "desktop", gate: "desktop-gate", label: "Desktop CI", dependencies: ["changes", "quality", "package"] }, { name: "server", scope: "service", gate: "gate", label: "Service CI", dependencies: ["changes", "quality"] }];

test("native packaging installs locked Electron before building and stops on installation failure", () => {
  const project = JSON.parse(readFileSync(join(root, "app/package.json"), "utf8")), directory = mkdtempSync(join(tmpdir(), "practiq-install-"));
  assert.equal(project.scripts["desktop:install"], "install-electron");
  assert.match(readFileSync(join(root, "Makefile"), "utf8"), /app-install:\n\tcd app && npm ci\n\tcd app && npm run desktop:install\n/);
  assert.ok(workflow("app").jobs.package.steps.some((step: any) => step.run?.includes("npm run package:electron -- .build/electron-ci")));
  try {
    mkdirSync(join(directory, "node_modules/.bin"), { recursive: true }); mkdirSync(join(directory, "scripts"));
    writeFileSync(join(directory, "package.json"), JSON.stringify({ type: "module", scripts: { "desktop:install": project.scripts["desktop:install"], "package:electron": project.scripts["package:electron"] } }));
    const installer = join(directory, "node_modules/.bin/install-electron"), events = join(directory, "events");
    writeFileSync(installer, '#!/bin/sh\nprintf "install\\n" >> "$INSTALL_EVENTS"\nexit "$INSTALL_EXIT"\n'); chmodSync(installer, 0o700);
    writeFileSync(join(directory, "scripts/package-electron.ts"), 'import { appendFileSync } from "node:fs"; appendFileSync(process.env.INSTALL_EVENTS, JSON.stringify(process.argv.slice(2)) + "\\n");');
    for (const exit of ["0", "19"]) {
      rmSync(events, { force: true });
      const result = spawnSync("npm", ["run", "package:electron", "--", "output with spaces"], { cwd: directory, encoding: "utf8", timeout: 10000, env: { ...process.env, INSTALL_EVENTS: events, INSTALL_EXIT: exit, npm_config_ignore_scripts: "false" } });
      assert.equal(result.status, Number(exit), result.stderr);
      assert.equal(readFileSync(events, "utf8"), exit === "0" ? 'install\n["output with spaces"]\n' : "install\n");
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

for (const item of templates) {
  test(`${item.name} workflow bootstraps its selector and final gate with Node and a pinned source`, () => {
    const value = workflow(item.name), changes = value.jobs.changes, gate = value.jobs[item.gate];
    assert.deepEqual(value.permissions, { contents: "read" });
    assert.deepEqual(value.on.push.branches, ["main"]); assert.equal(value.on.push.paths, undefined);
    assert.ok(Object.hasOwn(value.on, "pull_request")); assert.equal(value.on.pull_request, null);
    assert.deepEqual(changes.permissions, { contents: "read", "pull-requests": "read" });
    assert.deepEqual(changes.outputs, { required: "${{ steps.scope.outputs.required }}", sha: source });
    const selector = changes.steps.find((step: any) => step.id === "scope");
    assert.equal(selector.run, `node .github/scripts/ci-scope.ts scope ${item.scope}`);
    assert.equal(selector.env.CI_FULL_CHECKS, "${{ inputs.ref != '' }}");
    assert.equal(selector.env.GH_TOKEN, "${{ github.token }}");
    assert.equal(gate.name, item.label); assert.equal(gate.if, "${{ always() }}"); assert.deepEqual(gate.needs, item.dependencies);
    for (const owner of [changes, gate]) {
      const node = owner.steps.find((step: any) => step.uses?.startsWith("actions/setup-node@"));
      assert.equal(node.with["node-version"], "22");
      assert.equal(owner.steps.some((step: any) => step.uses?.startsWith("actions/setup-python@")), false);
      assert.equal(owner["continue-on-error"], undefined);
    }
    const sourceGuard = gate.steps.find((step: any) => step.env?.SOURCE_STATUS);
    assert.equal(sourceGuard.env.SOURCE_STATUS, "${{ needs.changes.result }}"); assert.equal(sourceGuard.run, 'test "$SOURCE_STATUS" = success');
    assert.ok(gate.steps.indexOf(sourceGuard) < gate.steps.findIndex((step: any) => step.uses?.startsWith("actions/checkout@")));
    for (const job of Object.values(value.jobs) as any[]) for (const step of job.steps ?? []) {
      assert.equal(step["continue-on-error"], undefined);
      if (step.uses) assert.match(step.uses, /^[^@]+@[a-f0-9]{40}$/);
      if (step.uses?.startsWith("actions/checkout@")) assert.equal(step.with.ref, source);
    }
  });

  test(`${item.name} workflow rejects unresolved and executable-looking source inputs before checkout`, () => {
    const changes = workflow(item.name).jobs.changes, validator = changes.steps[0];
    assert.equal(validator.id, "validate-source"); assert.equal(validator.env.SOURCE_SHA, source);
    for (const revision of ["a".repeat(40), "main", "v1.2.3", "a".repeat(39), "A".repeat(40), "", '$(exit 0)']) {
      const result = spawnSync("bash", ["-e", "-c", validator.run], { cwd: root, encoding: "utf8", timeout: 10000, env: { ...process.env, SOURCE_SHA: revision } });
      assert.equal(result.status === 0, revision === "a".repeat(40), revision);
    }
  });

  test(`${item.name} actual workflow outputs satisfy its Node gate and cancelled jobs fail`, () => {
    const value = workflow(item.name), changes = value.jobs.changes, gate = value.jobs[item.gate];
    const step = gate.steps.find((step: any) => step.env?.NEEDS);
    assert.equal(step.env.NEEDS, "${{ toJSON(needs) }}"); assert.equal(step.run, `node .github/scripts/ci-scope.ts gate ${item.scope}`);
    for (const required of [true, false]) {
      const context: Record<string, string> = { [source]: "ab".repeat(20), "${{ steps.scope.outputs.required }}": String(required) };
      const needs = Object.fromEntries(item.dependencies.map(job => [job, job === "changes" ? { result: "success", outputs: Object.fromEntries(Object.entries(changes.outputs).map(([key, expression]) => [key, context[expression as string]])) } : { result: required ? "success" : "skipped" }])) as Record<string, any>;
      const run = () => spawnSync("bash", ["-e", "-c", step.run], { cwd: root, env: { ...process.env, NEEDS: JSON.stringify(needs) }, encoding: "utf8", timeout: 10000 });
      const passed = run(); assert.equal(passed.status, 0, passed.stderr);
      needs.quality.result = "cancelled"; assert.equal(run().status, 1);
    }
  });
}

test("stable protected gate names remain mandatory and only one job runs common frontend checks", () => {
  const ruleset = JSON.parse(readFileSync(join(root, ".github/main-ruleset.json"), "utf8"));
  const required = ruleset.rules.find((rule: any) => rule.type === "required_status_checks").parameters.required_status_checks;
  assert.deepEqual(required.map((check: any) => check.context).sort(), templates.map(item => item.label).sort());
  assert.ok(required.every((check: any) => check.integration_id === 15368));
  assert.equal(ruleset.enforcement, "active");
  assert.deepEqual(ruleset.bypass_actors, []);
  assert.deepEqual(ruleset.conditions.ref_name, { include: ["refs/heads/main"], exclude: [] });
  const pullRequest = ruleset.rules.find((rule: any) => rule.type === "pull_request");
  assert.equal(pullRequest.parameters.required_review_thread_resolution, true);
  assert.equal(pullRequest.parameters.required_approving_review_count, 0);
  for (const key of ["require_extra_approval_for_unattributed_changes", "require_code_owner_review", "require_last_push_approval"]) assert.equal(pullRequest.parameters[key], false);
  assert.ok(ruleset.rules.some((rule: any) => rule.type === "non_fast_forward"));
  assert.ok(ruleset.rules.some((rule: any) => rule.type === "deletion"));
  const jobs = templates.flatMap(item => Object.entries(workflow(item.name).jobs));
  const frontend = jobs.filter(([, job]: any) => job.steps?.some((step: any) => step.run?.includes("npm run check:ui")));
  assert.equal(frontend.length, 1); assert.equal((frontend[0][1] as any).name, "App quality");
  const backend = jobs.filter(([, job]: any) => job.steps?.some((step: any) => step.run === "npm run test:desktop"));
  assert.equal(backend.length, 1); assert.equal((backend[0][1] as any).name, "Embedded AI quality");
  const quality = workflow("app").jobs.quality;
  assert.ok(quality.steps.some((step: any) => step.run === "node --test .github/scripts/*.test.ts"));
  const mirror = quality.steps.find((step: any) => step.run?.includes("/etc/apt/apt-mirrors.txt"));
  assert.ok(mirror); assert.ok(new Set(mirror.run.match(/https:\/\/[a-z.]+\/ubuntu\//g)).size >= 2);
  assert.ok(mirror.run.includes('Acquire::Retries "3";'));
  for (const transport of ["http", "https"]) assert.ok(mirror.run.includes(`Acquire::${transport}::Timeout "15";`));
  assert.doesNotMatch(mirror.run, /mirrors\.edge\.kernel\.org/);
  for (const name of ["maintainer", "review-signal", "issue-labels", "pr-labels"]) assert.equal(existsSync(join(root, `.github/workflows/${name}.yml`)), false);
  for (const name of ["maintainer", "issue-labeler", "pr-labeler"]) for (const suffix of [".mjs", ".test.mjs"]) assert.equal(existsSync(join(root, `.github/scripts/${name}${suffix}`)), false);
});

test("embedded AI uses Node without PostgreSQL, RabbitMQ or the retired Python runtime", () => {
  const value = workflow("server"), quality = value.jobs.quality;
  assert.equal(value.name, "Embedded AI");
  assert.equal(quality.name, "Embedded AI quality"); assert.equal(quality["runs-on"], "macos-15");
  assert.equal(quality.needs, "changes"); assert.equal(quality.if, "needs.changes.outputs.required == 'true'");
  assert.equal(quality.services, undefined); assert.equal(quality.strategy, undefined);
  const node = quality.steps.find((step: any) => step.uses?.startsWith("actions/setup-node@"));
  assert.equal(node.with["node-version"], "24");
  const commands = quality.steps.map((step: any) => step.run ?? "").join("\n");
  for (const command of ["npm ci", "npm run contracts:check", "npm run check:packaging", "node --test .github/scripts/*.test.ts", "npm run test:desktop", "npm audit --audit-level=high"]) assert.ok(commands.includes(command), command);
  assert.doesNotMatch(JSON.stringify(value.jobs), /setup-python|setup-uv|postgres|rabbitmq|docker run|make verify/);
  const reports = quality.steps.find((step: any) => step.uses?.startsWith("actions/upload-artifact@"));
  assert.equal(reports.if, "${{ always() }}"); assert.ok(reports.with.path.includes("coverage/desktop/"));
  assert.ok(reports.with.path.includes("app/.build/reports/desktop.xml")); assert.equal(reports.with["retention-days"], 14);
  const testConfig = (desktopConfig as any).test;
  assert.deepEqual(testConfig.coverage.include, ["desktop/**/*.ts"]); assert.deepEqual(testConfig.coverage.exclude, ["desktop/**/*.test.ts"]);
  for (const key of ["statements", "lines", "functions"]) assert.ok(testConfig.coverage.thresholds[key] >= 90);
  assert.equal(testConfig.coverage.reportOnFailure, true);
  assert.ok(testConfig.coverage.thresholds.branches >= 85);
  assert.ok(JSON.parse(readFileSync(join(root, "app/package.json"), "utf8")).scripts["test:desktop"].includes("--coverage"));
});
