import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ImportSettings } from "../src/contracts.generated.js";
import { validateContract } from "./contracts.js";
import { AppError, invariant } from "./errors.js";
import { readBounded, regularFileExists, syncDirectory, writeNewFile } from "./filesystem.js";
import { object } from "./question-contract.js";
import { parseJson } from "./document-contract.js";
import { costSettings, noCost } from "./cost-budget.js";

export const PROVIDER_URLS = { dashscope: "https://dashscope.aliyuncs.com/compatible-mode/v1", deepseek: "https://api.deepseek.com", moonshot: "https://api.moonshot.cn/v1", openai: "" };
export type AiPreferences = import("../src/contracts.generated.js").DesktopAiPreferences;
export type ModelSettings = AiPreferences["model"];
export interface SecretCrypto {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(value: string): Promise<Buffer>;
  decryptStringAsync(value: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
}
export const secretNames = ["modelApiKey", "tencentSecretId", "tencentSecretKey"] as const;
export type AiSecrets = Record<typeof secretNames[number], string>;
interface SettingsRecord { version: 1; revision: string; preferences: AiPreferences; secrets: Record<keyof AiSecrets, string | null> }
export type AiSettingsView = import("../src/contracts.generated.js").DesktopAiSettingsView;
export interface AiSnapshot { revision: string; preferences: AiPreferences; secrets: AiSecrets }
const defaults = (): AiPreferences => ({ model: { provider: "openai", baseUrl: "", modelId: "", maxOutputTokens: 16384, timeoutSeconds: 180 }, import: { tencentConcurrency: 2, readRetryCount: 2, retryBaseSeconds: 1, deduplicateQuestions: false, generateAnswers: false }, maxCalls: 400, runTimeoutSeconds: 1800, tencentCos: { enabled: false, bucket: "", region: "" } });
function strict(value: unknown, keys: string[]): Record<string, unknown> {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key)), "LOCAL_RESPONSE_INVALID", "Unsupported AI settings fields"); return object(value);
}
export function modelEndpoint(value: unknown): string {
  invariant(typeof value === "string" && value.length <= 2048 && !/[\p{Cc}?#]/u.test(value), "LOCAL_URL_INVALID", "Invalid model endpoint");
  if (!value.trim()) return "";
  const url = new URL(value.trim());
  invariant(!url.username && !url.password && (url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)), "LOCAL_URL_INVALID", "Use HTTPS or a loopback model endpoint without credentials");
  return url.href.replace(/\/+$/, "");
}
export function validateAiPreferences(value: unknown): AiPreferences {
  const p = strict(value, ["model", "import", "maxCalls", "runTimeoutSeconds", "tencentCos", "cost"]), model = strict(p.model, ["provider", "baseUrl", "modelId", "maxOutputTokens", "timeoutSeconds"]), cos = strict(p.tencentCos, ["enabled", "bucket", "region"]), runTimeoutSeconds = p.runTimeoutSeconds === undefined ? 1800 : p.runTimeoutSeconds;
  invariant(typeof runTimeoutSeconds === "number" && Number.isFinite(runTimeoutSeconds) && runTimeoutSeconds > 0 && (!Number.isInteger(runTimeoutSeconds) || Number.isSafeInteger(runTimeoutSeconds)), "LOCAL_FILTER_INVALID", "Run timeout must be a positive, JSON-safe number of seconds");
  invariant(typeof model.provider === "string" && Object.hasOwn(PROVIDER_URLS, model.provider) && typeof model.modelId === "string" && model.modelId.length <= 255 && !/\p{Cc}/u.test(model.modelId), "LOCAL_MODEL_ID_INVALID", "Invalid model provider or ID");
  invariant(Number.isSafeInteger(model.maxOutputTokens) && Number(model.maxOutputTokens) >= 1 && Number(model.maxOutputTokens) <= 131072 && Number.isSafeInteger(model.timeoutSeconds) && Number(model.timeoutSeconds) >= 1 && Number(model.timeoutSeconds) <= 600 && Number.isSafeInteger(p.maxCalls) && Number(p.maxCalls) >= 1 && Number(p.maxCalls) <= 10000, "LOCAL_FILTER_INVALID", "Invalid model limits");
  validateContract("ImportSettings", p.import);
  invariant(typeof cos.enabled === "boolean" && typeof cos.bucket === "string" && typeof cos.region === "string" && (!cos.bucket || /^[a-z0-9][a-z0-9-]{0,62}-[1-9][0-9]{4,19}$/.test(cos.bucket)) && (!cos.region || /^[a-z][a-z0-9-]{1,62}$/.test(cos.region)) && (!cos.enabled || cos.bucket && cos.region), "LOCAL_FILTER_INVALID", "Invalid private COS staging settings");
  return { model: { provider: model.provider as ModelSettings["provider"], baseUrl: modelEndpoint(model.baseUrl), modelId: model.modelId.trim(), maxOutputTokens: Number(model.maxOutputTokens), timeoutSeconds: Number(model.timeoutSeconds) }, import: structuredClone(p.import) as ImportSettings, maxCalls: Number(p.maxCalls), runTimeoutSeconds, tencentCos: { enabled: cos.enabled, bucket: cos.bucket, region: cos.region }, ...(p.cost === undefined ? {} : { cost: structuredClone(costSettings(p.cost as AiPreferences["cost"])) }) };
}
function secret(value: unknown): string {
  invariant(typeof value === "string" && Buffer.byteLength(value) <= 8192 && !/\p{Cc}/u.test(value), "LOCAL_FILTER_INVALID", "Invalid credential value"); return value.trim();
}
function decodeRecord(value: unknown): SettingsRecord {
  const record = strict(value, ["version", "revision", "preferences", "secrets"]), secrets = strict(record.secrets, [...secretNames]);
  invariant(record.version === 1 && typeof record.revision === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(record.revision), "LOCAL_RESPONSE_INVALID", "Unsupported AI settings version");
  for (const key of secretNames) invariant(secrets[key] === null || typeof secrets[key] === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(secrets[key] as string) && Buffer.from(secrets[key] as string, "base64").toString("base64") === secrets[key] && String(secrets[key]).length <= 32768, "LOCAL_RESPONSE_INVALID", "Invalid encrypted credential");
  return { version: 1, revision: record.revision, preferences: validateAiPreferences(record.preferences), secrets: secrets as SettingsRecord["secrets"] };
}

/** Workers read only validated budget policy; this never decrypts credentials. */
export function savedCostPolicy(directory: string, required = false) {
  const path = join(directory, "electron-ai-settings-v1.json");
  if (regularFileExists(path)) return decodeRecord(parseJson(readBounded(path, 128 * 1024))).preferences.cost ?? noCost();
  invariant(!required, "COST_STORE_UNAVAILABLE", "Saved budget policy is missing; no new model or recognition work is authorized"); return undefined;
}

/** Only the Electron main process writes settings and accesses the OS encryption adapter. */
export class AiSettings {
  private readonly initial: SettingsRecord = { version: 1, revision: randomUUID(), preferences: defaults(), secrets: { modelApiKey: null, tencentSecretId: null, tencentSecretKey: null } };
  private queue: Promise<unknown> = Promise.resolve();
  readonly path: string;
  constructor(readonly directory: string, readonly crypto: SecretCrypto) { this.path = join(directory, "electron-ai-settings-v1.json"); }
  private read(): SettingsRecord { return regularFileExists(this.path) ? decodeRecord(parseJson(readBounded(this.path, 128 * 1024))) : structuredClone(this.initial); }
  private viewOf(record: SettingsRecord): AiSettingsView { return { revision: record.revision, preferences: structuredClone(record.preferences), configured: Object.fromEntries(secretNames.map(key => [key, record.secrets[key] !== null])) as AiSettingsView["configured"] }; }
  async view(): Promise<AiSettingsView> { await this.queue; return this.viewOf(this.read()); }
  save(input: unknown): Promise<AiSettingsView> {
    const operation = this.queue.then(async () => {
      const patch = strict(input, ["revision", "preferences", "secrets"]), current = this.read(), updates = patch.secrets === undefined ? {} : strict(patch.secrets, [...secretNames]);
      invariant(patch.revision === current.revision, "LOCAL_SETTINGS_CHANGED", "AI settings changed; reload before saving");
      const preferences = validateAiPreferences(patch.preferences), secrets = { ...current.secrets };
      invariant(preferences.model.baseUrl === current.preferences.model.baseUrl || !secrets.modelApiKey || Object.hasOwn(updates, "modelApiKey"), "LOCAL_KEY_TARGET_CHANGED", "Set or clear the API key when changing its endpoint");
      for (const key of secretNames) if (Object.hasOwn(updates, key)) {
        const value = secret(updates[key]);
        if (!value) { secrets[key] = null; continue; }
        invariant(await this.crypto.isAsyncEncryptionAvailable(), "LOCAL_SECRET_UNAVAILABLE", "OS credential encryption is unavailable");
        try { secrets[key] = (await this.crypto.encryptStringAsync(JSON.stringify({ version: 1, key, endpoint: key === "modelApiKey" ? preferences.model.baseUrl : "https://ocr.tencentcloudapi.com", value }))).toString("base64"); }
        catch { throw new AppError("LOCAL_SECRET_UNAVAILABLE", "Credential encryption failed"); }
      }
      const next: SettingsRecord = { version: 1, revision: randomUUID(), preferences, secrets }; decodeRecord(next);
      mkdirSync(this.directory, { recursive: true, mode: 0o700 }); regularFileExists(this.path);
      const temporary = join(this.directory, `.ai-settings-${randomUUID()}`);
      try { writeNewFile(temporary, Buffer.from(JSON.stringify(next))); regularFileExists(this.path); renameSync(temporary, this.path); syncDirectory(this.directory); }
      finally { rmSync(temporary, { force: true }); }
      return this.viewOf(next);
    });
    this.queue = operation.catch(() => {}); return operation;
  }
  async snapshot(): Promise<AiSnapshot> {
    await this.queue; const record = this.read(), secrets: AiSecrets = { modelApiKey: "", tencentSecretId: "", tencentSecretKey: "" };
    for (const key of secretNames) if (record.secrets[key] !== null) {
      invariant(await this.crypto.isAsyncEncryptionAvailable(), "LOCAL_SECRET_UNAVAILABLE", "OS credential encryption is unavailable");
      try {
        const decrypted = await this.crypto.decryptStringAsync(Buffer.from(record.secrets[key]!, "base64")), value = strict(JSON.parse(decrypted.result), ["version", "key", "endpoint", "value"]);
        invariant(value.version === 1 && value.key === key && value.endpoint === (key === "modelApiKey" ? record.preferences.model.baseUrl : "https://ocr.tencentcloudapi.com"), "LOCAL_SECRET_UNAVAILABLE", "Credential target does not match its settings"); secrets[key] = secret(value.value);
      } catch { throw new AppError("LOCAL_SECRET_UNAVAILABLE", "Credentials could not be read; save them again in Settings"); }
    }
    return { revision: record.revision, preferences: record.preferences, secrets };
  }
}
