import { createHash, createHmac } from "node:crypto";
import type { AiSnapshot } from "./ai-settings.js";
import { hash } from "./assets.js";
import type { HttpFetch } from "./ai-http.js";
import { AppError, invariant } from "./errors.js";

export interface CosStaging { bucket: string; region: string; objectKey: string; sha256: string; deleted: boolean; cleanupError?: "TENCENT_COS_CLEANUP_FAILED" }
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
function deployment(config: AiSnapshot) {
  const value = config.preferences.tencentCos;
  invariant(value.enabled && /^[a-z0-9][a-z0-9-]{0,62}-[1-9][0-9]{4,19}$/.test(value.bucket) && /^[a-z][a-z0-9-]{1,62}$/.test(value.region), "TENCENT_COS_NOT_CONFIGURED", "Configure a private COS bucket and region");
  invariant(config.secrets.tencentSecretId && config.secrets.tencentSecretKey && !/[\p{Cc}&=]/u.test(config.secrets.tencentSecretId), "TENCENT_NOT_CONFIGURED", "Configure Tencent credentials"); return value;
}
export function stagingObject(config: AiSnapshot, taskId: string, unit: string, sha256: string): CosStaging {
  const { bucket, region } = deployment(config);
  invariant(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(taskId) && /^[A-Za-z0-9:_-]{1,128}$/.test(unit) && /^[a-f0-9]{64}$/.test(sha256), "TENCENT_COS_CONFLICT", "Invalid staged source identity");
  return { bucket, region, objectKey: `practiq-import/${hash(`${taskId}/${unit}`)}/${sha256}`, sha256, deleted: false };
}
export function validateStaging(value: unknown, config: AiSnapshot, taskId: string, unit: string, sha256: string): CosStaging {
  const expected = stagingObject(config, taskId, unit, sha256), record = value as CosStaging;
  invariant(record && typeof record === "object" && !Array.isArray(record) && Object.keys(record).every(key => ["bucket", "region", "objectKey", "sha256", "deleted", "cleanupError"].includes(key)) && ["bucket", "region", "objectKey", "sha256"].every(key => record[key as keyof CosStaging] === expected[key as keyof CosStaging]) && typeof record.deleted === "boolean" && (record.cleanupError === undefined || record.cleanupError === "TENCENT_COS_CLEANUP_FAILED"), "TENCENT_COS_CONFLICT", "Staged source belongs to another task, source or deployment"); return record;
}
/** COS V5 uses the hex signing key as text; signed URLs are ephemeral request data. */
export function cosAuthorization(method: string, path: string, headers: Record<string, string>, config: AiSnapshot, start: number, ttl: number): string {
  deployment(config); invariant(Number.isSafeInteger(start) && start >= 0 && Number.isSafeInteger(ttl) && ttl > 0 && ttl <= 3630, "TENCENT_COS_CONFLICT", "Invalid COS signature lifetime");
  const time = `${start};${start + ttl}`, entries = Object.entries(headers).map(([key, value]) => [encode(key.toLowerCase()), encode(value)]).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const request = `${method.toLowerCase()}\n${path}\n\n${entries.map(([key, value]) => `${key}=${value}`).join("&")}\n`, signingKey = createHmac("sha1", config.secrets.tencentSecretKey).update(time).digest("hex"), string = `sha1\n${time}\n${createHash("sha1").update(request).digest("hex")}\n`;
  return `q-sign-algorithm=sha1&q-ak=${config.secrets.tencentSecretId}&q-sign-time=${time}&q-key-time=${time}&q-header-list=${entries.map(([key]) => key).join(";")}&q-url-param-list=&q-signature=${createHmac("sha1", signingKey).update(string).digest("hex")}`;
}
function target(record: CosStaging, config: AiSnapshot): { host: string; path: string } {
  const { bucket, region } = deployment(config);
  invariant(record.bucket === bucket && record.region === region && /^practiq-import\/[a-f0-9]{64}\/[a-f0-9]{64}$/.test(record.objectKey) && record.objectKey.split("/").at(-1) === record.sha256, "TENCENT_COS_CONFLICT", "Invalid private staging target"); return { host: `${bucket}.cos.${region}.myqcloud.com`, path: `/${record.objectKey}` };
}
export function sourceUrl(record: CosStaging, config: AiSnapshot, timestamp = Math.floor(Date.now() / 1000)): string {
  const { host, path } = target(record, config), signature = cosAuthorization("GET", path, { host }, config, timestamp - 30, 3630);
  return `https://${host}${path}?${new URLSearchParams(signature).toString()}`;
}
export class TencentStaging {
  constructor(private readonly http: HttpFetch = fetch) {}
  async upload(record: CosStaging, bytes: Uint8Array, mediaType: string, config: AiSnapshot, signal?: AbortSignal): Promise<void> {
    const { host, path } = target(record, config); invariant(!record.deleted && hash(bytes) === record.sha256, "DOCUMENT_CHECKSUM_MISMATCH", "Staged source differs from its immutable bytes");
    invariant(/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(mediaType), "INVALID_REFERENCE", "Invalid source media type");
    const md5 = createHash("md5").update(bytes).digest(), headers: Record<string, string> = { host, "content-type": mediaType, "content-length": String(bytes.length), "content-md5": md5.toString("base64"), "x-cos-acl": "private", "x-cos-server-side-encryption": "AES256" };
    headers.Authorization = cosAuthorization("PUT", path, headers, config, Math.floor(Date.now() / 1000) - 30, 330);
    try {
      const timeout = AbortSignal.timeout(120000), response = await this.http(`https://${host}${path}`, { method: "PUT", headers, body: Buffer.from(bytes), redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      const verified = response.ok && response.headers.get("etag")?.replace(/^"|"$/g, "") === md5.toString("hex"); await response.body?.cancel().catch(() => {});
      invariant(verified, "TENCENT_COS_UPLOAD_FAILED", "Private COS upload failed or returned an unexpected checksum");
    } catch { signal?.throwIfAborted(); throw new AppError("TENCENT_COS_UPLOAD_FAILED", "Private COS upload failed; explicitly resume staging without transport fallback"); }
  }
  async delete(record: CosStaging, config: AiSnapshot, signal?: AbortSignal): Promise<void> {
    const { host, path } = target(record, config), headers: Record<string, string> = { host }; headers.Authorization = cosAuthorization("DELETE", path, headers, config, Math.floor(Date.now() / 1000) - 30, 330);
    try {
      const timeout = AbortSignal.timeout(30000), response = await this.http(`https://${host}${path}`, { method: "DELETE", headers, redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      await response.body?.cancel().catch(() => {}); invariant(response.ok, "TENCENT_COS_CLEANUP_FAILED", "Private COS cleanup failed");
    } catch { signal?.throwIfAborted(); throw new AppError("TENCENT_COS_CLEANUP_FAILED", "Private COS cleanup failed; explicitly resume cleanup without recognition resubmission"); }
  }
}
