import assert from "node:assert/strict";
import { _electron as electron } from "playwright";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";
import { version } from "./release-data.ts";
import type { DesktopBridge } from "../desktop/bridge.js";
import type { WebPreferences } from "electron";
declare global { interface Window { practiq?: DesktopBridge } }

assert.ok(process.argv[2], "Pass the package output directory");
const release = realpathSync(process.argv[2]), report = JSON.parse(readFileSync(join(release, "package-report.json"), "utf8")), temporary = realpathSync(mkdtempSync(join(tmpdir(), "practiq-installed-"))), mount = join(temporary, "mount"), installed = join(temporary, "installed"), profile = join(temporary, "profile"), evidence = resolve(".build/evidence");
version(`v${report.appVersion}`); assert.ok(["arm64", "x64"].includes(report.arch)); assert.equal(report.dmg.file, `PractiQ-${report.appVersion}-${report.arch}.dmg`);
assert.equal(createHash("sha256").update(readFileSync(join(release, report.dmg.file))).digest("hex"), report.dmg.sha256, "DMG checksum differs from its build receipt");
mkdirSync(mount); mkdirSync(installed); mkdirSync(evidence, { recursive: true }); let mounted = false, instance: Awaited<ReturnType<typeof electron.launch>> | undefined;
const run = (command: string, args: string[]) => { const result = spawnSync(command, args, { encoding: "utf8", timeout: 30000 }); if (result.error) throw result.error; assert.equal(result.status, 0, `${command} failed: ${result.stderr}`); };
let stage = "startup";
const watchdog = setTimeout(() => { console.error(`Package check timed out during ${stage}; macOS may require Keychain approval for a new signature.`); instance?.process().kill("SIGTERM"); const force = setTimeout(() => { const process = instance?.process(); if (process && process.exitCode === null && process.signalCode === null) process.kill("SIGKILL"); }, 2000); force.unref(); }, 120000); watchdog.unref();
const environment: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !["ELECTRON_RUN_AS_NODE", "PRACTIQ_DATA_DIR", "PRACTIQ_DEV_URL"].includes(key)) environment[key] = value;
environment.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const launch = () => electron.launch({ executablePath: join(installed, "PractiQ.app/Contents/MacOS/PractiQ"), cwd: temporary, args: [`--user-data-dir=${profile}`, "--lang=zh-CN"], env: environment, timeout: 20000 });
try {
  run("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, join(release, report.dmg.file)]); mounted = true;
  cpSync(join(mount, "PractiQ.app"), join(installed, "PractiQ.app"), { recursive: true, verbatimSymlinks: true });
  run("/usr/bin/hdiutil", ["detach", mount]); mounted = false; run("/usr/bin/codesign", ["--verify", "--deep", "--strict", join(installed, "PractiQ.app")]);
  instance = await launch(); const page = await instance.firstWindow({ timeout: 20000 }); page.setDefaultTimeout(15000);
  const errors: string[] = [], http: string[] = []; page.on("pageerror", error => errors.push(error.message)); page.on("request", request => { if (/^https?:/.test(request.url())) http.push(request.url()); });
  await page.waitForFunction(() => Boolean(window.practiq?.request));
  const state = await instance.evaluate(({ app, BrowserWindow }) => { const preferences = (BrowserWindow.getAllWindows()[0].webContents as unknown as { getLastWebPreferences(): WebPreferences }).getLastWebPreferences(); return { packaged: app.isPackaged, userData: app.getPath("userData"), appPath: app.getAppPath(), executable: process.execPath, node: process.versions.node, electron: process.versions.electron, sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration }; });
  assert.equal(state.packaged, true); assert.equal(realpathSync(state.userData), realpathSync(profile)); assert.ok(state.appPath.startsWith(installed)); assert.deepEqual([state.sandbox, state.contextIsolation, state.nodeIntegration], [true, true, false]);
  const bridge = async (request: unknown, target = page) => { const reply = await target.evaluate(value => window.practiq!.request(value), request) as { ok: boolean; value: any; error?: { code: string } }; assert.equal(reply.ok, true, reply.error?.code ?? "Packaged command failed"); return reply.value; };
  const directory = join(profile, "electron-migration/v4"); assert.equal((await bridge({ type: "info" })).dataDirectory, directory); assert.equal((await bridge({ type: "banks" })).length, 0);
  await bridge({ type: "add_example_bank" }); assert.equal((await bridge({ type: "banks" }))[0].count, 20);
  const bankId = await bridge({ type: "save_bank", id: null, title: "安装包验证", description: "离线运行与恢复" });
  await bridge({ type: "save_question_tree", bank_id: bankId, root_id: null, questions: [{ id: "packaged-question", stem: "安装后的离线判断验证", questionTypeId: "判断题", answerMode: "true_false", answerPayload: { value: true }, analysis: "不依赖独立后端", sourceText: "固定离线用例", needsReview: false }] });
  await page.getByRole("button", { name: "刷新", exact: true }).click(); const card = page.locator('[data-slot="card"]').filter({ has: page.getByText("安装包验证", { exact: true }) });
  await card.getByRole("button", { name: "开始练习", exact: true }).click(); await page.getByRole("dialog").getByRole("button", { name: "立即开始", exact: true }).click(); await page.getByText("安装后的离线判断验证", { exact: true }).waitFor();
  await page.getByRole("radio", { name: "正确", exact: true }).click(); await page.getByRole("button", { name: /提交答案/ }).click(); await page.getByText("回答正确", { exact: true }).waitFor();
  await page.getByRole("button", { name: "结束练习", exact: true }).click(); await page.getByRole("alertdialog").getByRole("button", { name: "提交草稿并结束", exact: true }).click(); await page.getByRole("heading", { name: "练习回顾", exact: true }).waitFor(); await page.screenshot({ path: join(evidence, "electron-packaged-practice.png") });
  const settings = await bridge({ type: "ai_settings" }); assert.ok(Object.values(settings.configured).every(value => value === false));
  const capabilities = await bridge({ type: "document_request", request: { type: "capabilities", revision: settings.revision } }); assert.equal(capabilities.value.modelConfigured, false); assert.equal(capabilities.value.parserConfigured, false);
  stage = "bundled helpers";
  const helpers = await instance.evaluate(async ({ app }, data) => {
    const { Worker } = process.getBuiltinModule("node:worker_threads"), { pathToFileURL } = process.getBuiltinModule("node:url"), moduleBase = pathToFileURL(`${app.getAppPath()}/.build/electron/app/desktop/`).href;
    const worker = new Worker(`const {parentPort,workerData:d}=require('node:worker_threads');(async()=>{const [{TencentBundle},{renderPdf}]=await Promise.all(['tencent-bundle','pdf-render'].map(name=>import(d.moduleBase+name+'.js')));const codecs=[];for(const [codec,encoded] of Object.entries(d.codecs)){const bundle=await TencentBundle.open(Buffer.from(encoded,'base64'),{pageCount:1});try{const image=await bundle.image('image.png');if(!image.bytes.length)throw Error('Empty image');codecs.push(codec);}finally{bundle.close();}}const pdf=await renderPdf(Buffer.from(d.pdf,'base64'),new AbortController().signal,{maxPages:3,maxPixels:25000000,maxBytes:52428800,timeoutMs:20000});parentPort.postMessage({codecs,pages:pdf.images.length,wasm:pdf.engine.wasmSha256});})().catch(error=>parentPort.postMessage({error:error.code||'PACKAGE_HELPER_FAILED'}));`, { eval: true, workerData: { ...data, moduleBase }, env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 256 } });
    try { return await new Promise<{ codecs: string[]; pages: number; wasm: string; error?: string }>((resolve, reject) => { const timer = setTimeout(() => reject(Error("Packaged helpers timed out")), 30000); worker.once("message", value => { clearTimeout(timer); resolve(value); }); worker.once("error", error => { clearTimeout(timer); reject(error); }); }); } finally { await worker.terminate(); }
  }, { codecs: JSON.parse(readFileSync("fixtures/tencent/zip-codecs.json", "utf8")), pdf: readFileSync("fixtures/pdf/unembedded-cjk.pdf").toString("base64") });
  assert.equal(helpers.error, undefined); assert.equal(helpers.codecs.length, 5); assert.ok(helpers.pages > 0); assert.match(helpers.wasm, /^[a-f0-9]{64}$/);
  const backup = join(temporary, "backup.zip"); await instance.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, backup);
  await page.getByRole("button", { name: "设置", exact: true }).click(); await page.getByRole("button", { name: "导出备份", exact: true }).click(); await page.getByText(/备份已保存：/).waitFor(); assert.ok(existsSync(backup));
  const { BoundedZip } = await import(new URL("../.build/electron/app/desktop/zip.js", import.meta.url).href) as typeof import("../desktop/zip.js");
  const archive = await BoundedZip.open(backup, { archiveBytes: 600 * 1024 * 1024, expandedBytes: 600 * 1024 * 1024, entries: 100000 });
  try { assert.ok([...archive.entries.keys()].every(name => ["manifest.json", "practiq.sqlite"].includes(name) || /^assets\/[a-f0-9]{64}$/.test(name)), "AI settings or credentials leaked into the practice backup"); } finally { archive.close(); }
  const extra = await bridge({ type: "save_bank", id: null, title: "恢复前临时题库", description: "" }); await instance.evaluate(({ dialog }, filePath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] }); }, backup);
  await page.getByRole("button", { name: "导入与恢复", exact: true }).click(); await page.getByRole("menuitem", { name: "恢复学习数据备份", exact: true }).click(); await page.getByRole("alertdialog").getByRole("button", { name: "恢复备份", exact: true }).click(); await page.getByText(/恢复完成。原数据副本：/).waitFor(); assert.ok(!(await bridge({ type: "banks" })).some((bank: { id: string }) => bank.id === extra));
  const calls = new DatabaseSync(join(directory, "ai.sqlite"), { readOnly: true }); try { assert.equal(calls.prepare("SELECT count(*) AS n FROM ai_calls").get()!.n, 0); } finally { calls.close(); }
  assert.deepEqual(errors, []); assert.deepEqual(http, []); await instance.close(); instance = await launch(); const reopened = await instance.firstWindow({ timeout: 20000 }); await reopened.waitForFunction(() => Boolean(window.practiq?.request));
  const banks = await reopened.evaluate(async () => { const reply = await window.practiq!.request({ type: "banks" }); if (!reply.ok) throw Error(reply.error.code); return reply.value as { id: string }[]; }); assert.ok(banks.some(bank => bank.id === bankId)); assert.equal(banks.length, 2);
  await reopened.getByText("安装包验证", { exact: true }).waitFor();
  let existingDataReport: string | undefined;
  if (process.argv[3]) {
    const script = join(temporary, "verify-existing-data.mjs"); writeFileSync(script, stripTypeScriptTypes(readFileSync("scripts/verify-existing-data.ts", "utf8")), { mode: 0o600 });
    const checked = spawnSync(state.executable, [script, realpathSync(process.argv[3]), join(state.appPath, ".build/electron/app/desktop")], { cwd: process.cwd(), env: { ...environment, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", timeout: 30000 });
    assert.equal(checked.status, 0, `Installed runtime rejected the existing-data copy: ${checked.stderr}`); existingDataReport = JSON.parse(checked.stdout.split("\n").find(line => line.startsWith('{"report":'))!).report;
    const result = JSON.parse(readFileSync(existingDataReport!, "utf8")); assert.equal(result.runtimeNode, state.node); assert.equal(result.runtimeImplementation, "installed-package"); assert.equal(result.originalProfileUnchanged, true);
  }
  await reopened.screenshot({ path: join(evidence, "electron-packaged-reopened.png") });
  const acceptance = { checkedAt: new Date().toISOString(), dmgSha256: report.dmg.sha256, version: report.appVersion, arch: report.arch, packaged: state.packaged, node: state.node, electron: state.electron, codesignVerified: true, sourceIndependentInstall: true, isolatedUserData: true, systemOnlyPath: true, sandbox: true, practice: true, backupRestore: true, restart: true, codecs: helpers.codecs, pdfPages: helpers.pages, paidCalls: 0, rendererHttpRequests: 0, existingDataCopy: Boolean(existingDataReport), existingDataReport, corePassed: true, credentialsEncrypted: false, credentialsExcludedFromBackup: false, credentialsDecryptAfterRestart: false, nativeDialogs: "substituted", notarized: false };
  const receipt = join(evidence, `electron-package-${report.dmg.sha256.slice(0, 12)}-${Date.now()}-acceptance.json`), publish = () => { const value = JSON.stringify(acceptance, null, 2) + "\n"; writeFileSync(receipt, value); writeFileSync(join(evidence, "electron-package-acceptance.json"), value); };
  publish(); console.log(`Installed package core passed: ${receipt}; verifying OS-protected credentials next`);
  const currentSettings = await bridge({ type: "ai_settings" }, reopened);
  stage = "OS credential initialization";
  watchdog.refresh();
  const testSecrets = { modelApiKey: "TEST_ONLY_PACKAGE_MODEL_KEY", tencentSecretId: "TEST_ONLY_PACKAGE_TENCENT_ID", tencentSecretKey: "TEST_ONLY_PACKAGE_TENCENT_KEY" };
  const savedSettings = await bridge({ type: "save_ai_settings", value: { revision: currentSettings.revision, preferences: { ...currentSettings.preferences, model: { ...currentSettings.preferences.model, baseUrl: "https://example.invalid/v1", modelId: "package-private-model" } }, secrets: testSecrets } }, reopened);
  assert.ok(Object.values(savedSettings.configured).every(value => value === true)); assert.equal(readFileSync(join(directory, "electron-ai-settings-v1.json"), "utf8").includes("TEST_ONLY_PACKAGE"), false);
  const credentialBackup = join(temporary, "credential-backup.zip"); await instance.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, credentialBackup); await bridge({ type: "backup" }, reopened);
  const protectedArchive = await BoundedZip.open(credentialBackup, { archiveBytes: 600 * 1024 * 1024, expandedBytes: 600 * 1024 * 1024, entries: 100000 });
  try { assert.ok([...protectedArchive.entries.keys()].every(name => ["manifest.json", "practiq.sqlite"].includes(name) || /^assets\/[a-f0-9]{64}$/.test(name))); } finally { protectedArchive.close(); }
  await instance.close(); instance = await launch(); const credentialWindow = await instance.firstWindow({ timeout: 20000 }); await credentialWindow.waitForFunction(() => Boolean(window.practiq?.request));
  stage = "OS credential decryption after restart";
  watchdog.refresh();
  const decrypted = await instance.evaluate(async ({ app, safeStorage }, data) => {
    const { createRequire } = process.getBuiltinModule("node:module"), { AiSettings } = createRequire(`${app.getAppPath()}/package.json`)("./.build/electron/app/desktop/ai-settings.js");
    const settings = new AiSettings(data.directory, { isAsyncEncryptionAvailable: () => safeStorage.isAsyncEncryptionAvailable(), encryptStringAsync: (value: string) => safeStorage.encryptStringAsync(value), decryptStringAsync: (value: Buffer) => safeStorage.decryptStringAsync(value) });
    const snapshot = await settings.snapshot(); return { matches: Object.entries(data.expected).every(([key, value]) => snapshot.secrets[key] === value), revision: snapshot.revision };
  }, { directory, expected: testSecrets }); assert.equal(decrypted.matches, true); assert.equal(decrypted.revision, savedSettings.revision);
  acceptance.credentialsEncrypted = true; acceptance.credentialsExcludedFromBackup = true; acceptance.credentialsDecryptAfterRestart = true; publish();
  console.log("Installed Electron package passed: isolated DMG copy, sandbox, offline practice, codecs/PDFium, embedded runtime, backup/restore and restart");
} finally { clearTimeout(watchdog); if (instance) { const process = instance.process(), force = setTimeout(() => process.kill("SIGKILL"), 5000); try { await instance.close().catch(() => {}); } finally { clearTimeout(force); } } if (mounted) run("/usr/bin/hdiutil", ["detach", mount]); rmSync(temporary, { recursive: true, force: true }); }
