import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AiSettings, type SecretCrypto } from "./ai-settings.js";

const directories: string[] = [];
function directory() { const path = mkdtempSync(join(tmpdir(), "practiq-settings-")); directories.push(path); return path; }
const crypto: SecretCrypto = { isAsyncEncryptionAvailable: async () => true, encryptStringAsync: async value => Buffer.from(Buffer.from(value).map(byte => byte ^ 0xa5)), decryptStringAsync: async value => ({ result: Buffer.from(value.map(byte => byte ^ 0xa5)).toString(), shouldReEncrypt: false }) };
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

it("persists credentials only through OS crypto and never returns them to the renderer", async () => {
  const path = directory(), settings = new AiSettings(path, crypto), before = await settings.view();
  const saved = await settings.save({ revision: before.revision, preferences: { ...before.preferences, model: { ...before.preferences.model, baseUrl: "https://model.example/v1/", modelId: "model" } }, secrets: { modelApiKey: "TEST_PRIVATE_MODEL_KEY", tencentSecretId: "TEST_PRIVATE_ID", tencentSecretKey: "TEST_PRIVATE_KEY" } });
  expect(saved.configured).toEqual({ modelApiKey: true, tencentSecretId: true, tencentSecretKey: true }); expect(JSON.stringify(saved)).not.toContain("TEST_PRIVATE"); expect(readFileSync(settings.path, "utf8")).not.toContain("TEST_PRIVATE");
  const reopened = new AiSettings(path, crypto), snapshot = await reopened.snapshot(); expect(snapshot.secrets.modelApiKey).toBe("TEST_PRIVATE_MODEL_KEY"); expect(snapshot.preferences.model.baseUrl).toBe("https://model.example/v1");
  await expect(reopened.save({ revision: before.revision, preferences: saved.preferences })).rejects.toThrow("changed");
  const cleared = await reopened.save({ revision: saved.revision, preferences: saved.preferences, secrets: { modelApiKey: "" } }); expect(cleared.configured.modelApiKey).toBe(false); expect(cleared.configured.tencentSecretKey).toBe(true);
});

it("binds model credentials to their configured endpoint and rejects plaintext-file tampering", async () => {
  const settings = new AiSettings(directory(), crypto), current = await settings.view();
  const saved = await settings.save({ revision: current.revision, preferences: { ...current.preferences, model: { ...current.preferences.model, baseUrl: "https://original.example/v1" } }, secrets: { modelApiKey: "private" } });
  await expect(settings.save({ revision: saved.revision, preferences: { ...saved.preferences, model: { ...saved.preferences.model, baseUrl: "https://changed.example/v1" } } })).rejects.toThrow("Set or clear");
  const record = JSON.parse(readFileSync(settings.path, "utf8")); record.preferences.model.baseUrl = "https://tampered.example/v1"; writeFileSync(settings.path, JSON.stringify(record));
  await expect(settings.snapshot()).rejects.toThrow("could not be read"); expect(readFileSync(settings.path, "utf8")).toContain("tampered.example");
});

it("serializes simultaneous saves and leaves the previous configuration intact on encryption failure", async () => {
  const settings = new AiSettings(directory(), crypto), before = await settings.view(), input = { revision: before.revision, preferences: before.preferences };
  const outcomes = await Promise.allSettled([settings.save(input), settings.save(input)]); expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
  const original = readFileSync(settings.path), view = await settings.view(), unavailable = new AiSettings(settings.directory, { ...crypto, isAsyncEncryptionAvailable: async () => false });
  await expect(unavailable.save({ revision: view.revision, preferences: view.preferences, secrets: { modelApiKey: "private" } })).rejects.toThrow("unavailable"); expect(readFileSync(settings.path)).toEqual(original);
});

it("refuses unknown nonempty settings and symbolic links without overwriting evidence", async () => {
  const path = directory(), target = join(path, "electron-ai-settings-v1.json"); writeFileSync(target, '{"version":99,"keep":"original"}');
  const settings = new AiSettings(path, crypto); await expect(settings.view()).rejects.toThrow(); expect(readFileSync(target, "utf8")).toContain("original");
  rmSync(target); const outside = join(path, "keep"); writeFileSync(outside, "original"); symlinkSync(outside, target);
  await expect(settings.view()).rejects.toThrow("regular file"); expect(readFileSync(outside, "utf8")).toBe("original");
});

it("defaults historical AI settings to a 30-minute run timeout without rewriting the file", async () => {
  const settings = new AiSettings(directory(), crypto), before = await settings.view(); await settings.save({ revision: before.revision, preferences: before.preferences });
  const record = JSON.parse(readFileSync(settings.path, "utf8")); delete record.preferences.runTimeoutSeconds; writeFileSync(settings.path, JSON.stringify(record)); const bytes = readFileSync(settings.path);
  expect((await settings.view()).preferences.runTimeoutSeconds).toBe(1800); expect(readFileSync(settings.path)).toEqual(bytes);
  const view = await settings.view(); expect((await settings.save({ revision: view.revision, preferences: { ...view.preferences, runTimeoutSeconds: 0.125 } })).preferences.runTimeoutSeconds).toBe(0.125);
});

it.each([0, -1, null, "1800", NaN, Infinity, Number.MAX_VALUE, Number.MAX_SAFE_INTEGER + 1])("rejects invalid run timeout %s without changing settings", async runTimeoutSeconds => {
  const settings = new AiSettings(directory(), crypto), before = await settings.view();
  await expect(settings.save({ revision: before.revision, preferences: { ...before.preferences, runTimeoutSeconds } })).rejects.toThrow("timeout"); expect((await settings.view()).revision).toBe(before.revision);
});
