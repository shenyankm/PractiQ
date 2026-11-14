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

test("default Make checks and installation use the single Node application", () => {
  const project = JSON.parse(readFileSync(join(root, "app/package.json"), "utf8"));
  assert.equal(project.scripts.tauri, undefined); assert.equal(project.devDependencies["@tauri-apps/cli"], undefined);
  for (const target of ["install", "install-locked", "dev", "test", "verify", "app-check", "audit", "test-e2e"]) {
    const result = spawnSync("make", ["--dry-run", target], { cwd: root, encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /python|uv |cargo|tauri|docker|postgres|rabbitmq/);
    for (const match of result.stdout.matchAll(/npm run ([a-z:]+)/g)) assert.ok(project.scripts[match[1]], `Unknown npm command in ${target}: ${match[1]}`);
    if (["install", "install-locked"].includes(target)) assert.match(result.stdout, /npm ci[\s\S]*npm run desktop:install/);
    if (["verify", "app-check"].includes(target)) assert.match(result.stdout, /node --test \.github\/scripts\/\*\.test\.ts[\s\S]*npm run check[\s\S]*npm run build/);
  }
  for (const command of ["contracts:check", "check:packaging", "check:ui", "test:tooling", "test:desktop"]) assert.ok(project.scripts.check.includes(`npm run ${command}`), command);
  assert.doesNotMatch(project.scripts.check, /cargo|python|tauri/);
});

test("historical contract bootstrap resolves the existing interpreter before uv sees it", () => {
  const step = workflow("app").jobs.quality.steps.find((value: any) => value.name === "Install locked service dependencies for contract checks");
  const directory = mkdtempSync(join(tmpdir(), "practiq-python reference-")), interpreter = join(directory, "python"), uv = join(directory, "uv"), events = join(directory, "events");
  try {
    writeFileSync(interpreter, "#!/bin/sh\nexit 0\n"); chmodSync(interpreter, 0o700);
    writeFileSync(uv, `#!${process.execPath}\nconst assert=require('node:assert/strict'),fs=require('node:fs');const args=process.argv.slice(2);assert.equal(args[args.indexOf('--python')+1],process.env.REFERENCE_PYTHON);fs.appendFileSync(process.env.REFERENCE_EVENTS,JSON.stringify(args)+'\\n');`); chmodSync(uv, 0o700);
    const result = spawnSync("bash", ["-e", "-c", step.run], { cwd: root, encoding: "utf8", timeout: 10000, env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, REFERENCE_PYTHON: interpreter, REFERENCE_EVENTS: events } });
    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(events, "utf8").trim().split("\n").map(value => JSON.parse(value));
    assert.equal(calls.length, 3); assert.equal(calls[0][0], "export"); assert.ok(calls[0].includes("--locked"));
    for (const args of calls.slice(1)) { assert.deepEqual(args.slice(0, 2), ["pip", "install"]); assert.ok(args.includes("--break-system-packages")); }
    assert.ok(calls[2].includes("--no-deps")); assert.deepEqual(calls[2].slice(-2), ["-e", "."]);
    const requirements = calls[0][calls[0].indexOf("-o") + 1]; assert.equal(calls[1][calls[1].indexOf("-r") + 1], requirements); assert.equal(existsSync(requirements), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

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
  assert.equal(reports.with["include-hidden-files"], true);
  const testConfig = (desktopConfig as any).test;
  assert.deepEqual(testConfig.coverage.include, ["desktop/**/*.ts"]); assert.deepEqual(testConfig.coverage.exclude, ["desktop/**/*.test.ts"]);
  for (const key of ["statements", "lines", "functions"]) assert.ok(testConfig.coverage.thresholds[key] >= 90);
  assert.equal(testConfig.coverage.reportOnFailure, true);
  assert.ok(testConfig.coverage.thresholds.branches >= 85);
  assert.ok(JSON.parse(readFileSync(join(root, "app/package.json"), "utf8")).scripts["test:desktop"].includes("--coverage"));
});

test("release checks and assembly use Node, full candidate history and embedded AI artifacts", () => {
  const value = workflow("release"), candidate = value.jobs.candidate, draft = value.jobs.draft;
  assert.deepEqual(Object.keys(value.on), ["workflow_dispatch"]); assert.deepEqual(value.permissions, { contents: "read" });
  assert.equal(value.concurrency["cancel-in-progress"], false); assert.deepEqual(draft.needs, ["candidate", "service", "apps"]);
  assert.deepEqual(value.jobs.apps.with, { ref: "${{ needs.candidate.outputs.sha }}", tag: "${{ inputs.tag }}", release: true });
  assert.equal(value.jobs.service.with.ref, "${{ needs.candidate.outputs.sha }}");
  for (const job of [candidate, draft]) {
    assert.equal(job.steps.find((step: any) => step.uses?.startsWith("actions/checkout@")).with["fetch-depth"], 0);
    assert.equal(job.steps.find((step: any) => step.uses?.startsWith("actions/checkout@")).with["persist-credentials"], false);
    assert.equal(job.steps.find((step: any) => step.uses?.startsWith("actions/setup-node@")).with["node-version"], "22");
    for (const step of job.steps) { assert.equal(step["continue-on-error"], undefined); if (step.uses) assert.match(step.uses, /^[^@]+@[a-f0-9]{40}$/); }
  }
  const checker = candidate.steps.find((step: any) => step.id === "candidate"); assert.ok(checker.run.includes('node app/scripts/release.ts check --tag "$RELEASE_TAG"'));
  assert.equal(checker.env.WORKFLOW_SHA, "${{ github.sha }}"); assert.equal(checker.env.WORKFLOW_REF, "${{ github.ref }}");
  assert.ok(candidate.steps.some((step: any) => step.run?.includes("gh api --paginate --slurp") && step.run.includes("node app/scripts/release.ts check-existing")));
  assert.equal(candidate.steps.some((step: any) => step.run?.includes("npm ci")), false);
  assert.doesNotMatch(JSON.stringify(value), /setup-python|release\.py|service-checks/);
  const downloads = draft.steps.filter((step: any) => step.uses?.startsWith("actions/download-artifact@"));
  assert.deepEqual(downloads.map((step: any) => step.with), [{ name: "release-macOS", path: "app/.build/release-inputs/release-macOS/" }, { name: "embedded-ai-checks", path: "app/.build/release-inputs/embedded-ai-checks/" }]);
  assert.ok(draft.steps.some((step: any) => step.run?.startsWith("node app/scripts/release.ts assemble ")));
  const packageJob = workflow("app").jobs.package, stage = packageJob.steps.find((step: any) => step.name === "Verify final installer and stage release assets");
  assert.equal(stage.if, "inputs.release"); assert.ok(stage.run.startsWith("node app/scripts/release.ts stage "));
  for (const option of ["--package app/.build/electron-ci", "--output app/.build/release", "--reports app/.build/release-reports", "--acceptance app/.build/evidence/electron-package-acceptance.json"]) assert.ok(stage.run.includes(option));
  assert.ok(packageJob.steps.indexOf(stage) > packageJob.steps.findIndex((step: any) => step.run?.includes("npm run test:package")));
  assert.equal(packageJob.steps.find((step: any) => step.uses?.startsWith("actions/checkout@")).with["fetch-depth"], "${{ inputs.release && '0' || '1' }}");
  assert.ok(workflow("app").jobs.quality.steps.some((step: any) => step.run === "npm run test:tooling"));
  assert.doesNotMatch(JSON.stringify(packageJob), /setup-python|rust-cache|rustup|cargo|tauri|prepare-package\.py|check-installer\.py/);
  assert.doesNotMatch(JSON.stringify(workflow("app").jobs.quality), /rust-cache|rustup|cargo/);
});

test("release assets are attested and verified before a non-replacing draft is created", () => {
  const draft = workflow("release").jobs.draft, steps = draft.steps;
  assert.deepEqual(draft.permissions, { contents: "write", "id-token": "write", attestations: "write" });
  const attest = steps.find((step: any) => step.id === "provenance"), verify = steps.find((step: any) => step.run?.includes("gh attestation verify")), create = steps.find((step: any) => step.run?.includes("gh release create"));
  assert.ok(steps.indexOf(attest) < steps.indexOf(verify) && steps.indexOf(verify) < steps.indexOf(create)); assert.equal(verify.if, undefined); assert.equal(create.if, undefined);
  for (const name of ["PractiQ_*", "SHA256SUMS.txt", "release-manifest.json", "release-evidence.zip"]) for (const source of [attest.with["subject-path"], verify.run, create.run]) assert.ok(source.includes(`app/.build/release-assets/${name}`));
  assert.equal(verify.env.CANDIDATE_SHA, "${{ needs.candidate.outputs.sha }}"); assert.equal(verify.env.ATTESTATION_BUNDLE, "${{ steps.provenance.outputs.bundle-path }}");
  for (const option of ['--source-digest "$CANDIDATE_SHA"', '--source-ref "refs/tags/$RELEASE_TAG"', '--signer-workflow "$GITHUB_REPOSITORY/.github/workflows/release.yml"', "--deny-self-hosted-runners"]) assert.ok(verify.run.includes(option));
  assert.ok(create.run.includes("--draft --verify-tag --latest=false")); assert.doesNotMatch(create.run, /--clobber|release publish/); assert.ok(create.run.includes('test "$remote_sha" = "$CANDIDATE_SHA"'));
  const creation = JSON.parse(readFileSync(join(root, ".github/release-tag-creation-ruleset.json"), "utf8")), immutable = JSON.parse(readFileSync(join(root, ".github/release-tag-immutability-ruleset.json"), "utf8"));
  for (const rules of [creation, immutable]) { assert.equal(rules.target, "tag"); assert.equal(rules.enforcement, "active"); assert.deepEqual(rules.conditions.ref_name, { include: ["refs/tags/v*"], exclude: [] }); }
  assert.deepEqual(creation.rules, [{ type: "creation" }]); assert.deepEqual(creation.bypass_actors, [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }]); assert.deepEqual(immutable.rules.map((rule: any) => rule.type).sort(), ["deletion", "update"]); assert.deepEqual(immutable.bypass_actors, []);
});
