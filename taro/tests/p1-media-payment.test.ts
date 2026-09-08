import assert from "node:assert/strict";
import test from "node:test";
import { ApiClient, type TransportRequest } from "../src/api/client";
import { MemorySessionStore } from "../src/auth/session";
import { downloadImage, type DownloadPlatform } from "../src/media/download";
import { mediaIdForUrl, TemporaryMedia, validImage } from "../src/media/temporary-media";
import { PaymentRecovery } from "../src/payments/recovery";
import type { PaymentIntent } from "../src/api/modules";
import { authPayload } from "./fixtures";

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const request: TransportRequest = { url: "https://api.test/api/v1/media/9/content", method: "GET", headers: { Authorization: "Bearer secret" } };

test("media URLs allow only the configured origin and exact authenticated resource path", () => {
  assert.equal(mediaIdForUrl(request.url, "https://api.test"), 9);
  assert.equal(mediaIdForUrl("/api/v1/media/9/content", "https://api.test"), 9);
  for (const url of ["https://evil.test/api/v1/media/9/content", "//evil.test/api/v1/media/9/content", "https://api.test.evil.test/api/v1/media/9/content", "https://api.test@evil.test/api/v1/media/9/content", "data:image/png;base64,aaa", "/api/v1/media/9/content?redirect=https://evil.test", "/api/v1/media/../9/content"]) assert.equal(mediaIdForUrl(url, "https://api.test"), null);
});

test("authenticated image returns a temporary native path and invalidation deletes only registered files", async () => {
  const removed: string[] = []; const files = new TemporaryMedia((path) => { removed.push(path); }); const calls: TransportRequest[] = [];
  const result = await downloadImage(request, { mime: "image/png", size: png.length }, files, { download: async (r) => { calls.push(r); return { status: 200, path: "wxfile://ours", mime: "image/png" }; }, read: () => png });
  assert.deepEqual(result.data, { data: { tempFilePath: "wxfile://ours" } }); assert.equal(calls[0].headers.Authorization, "Bearer secret");
  files.clear(); assert.deepEqual(removed, ["wxfile://ours"]); files.clear(); assert.equal(removed.length, 1);
});

test("media downloaded after account change/revocation is deleted without being exposed", async () => {
  const removed: string[] = []; const files = new TemporaryMedia((path) => { removed.push(path); });
  let resolve!: (value: Awaited<ReturnType<DownloadPlatform["download"]>>) => void;
  const pending = downloadImage(request, { mime: "image/png", size: png.length }, files, { download: () => new Promise((r) => { resolve = r; }), read: () => png });
  files.clear(); resolve({ status: 200, path: "wxfile://late", mime: "image/png" }); await assert.rejects(pending); assert.deepEqual(removed, ["wxfile://late"]);
});

test("JSON errors, wrong MIME/size and over-limit images never become image paths", async () => {
  assert.equal(validImage(png, "image/png", 11 * 1024 * 1024), false);
  for (const [mime, size, bytes] of [["application/json", 8, png], ["image/png", 9, png], ["image/png", 8, new Uint8Array(8)]] as const) {
    const removed: string[] = []; const files = new TemporaryMedia((path) => { removed.push(path); });
    await assert.rejects(downloadImage(request, { mime: "image/png", size }, files, { download: async () => ({ status: 200, path: "wxfile://bad", mime }), read: () => bytes })); assert.deepEqual(removed, ["wxfile://bad"]);
  }
});

test("media download 401 uses the ordinary refresh protocol; revoked media deletes its error file", async () => {
  const removed: string[] = []; const files = new TemporaryMedia((path) => { removed.push(path); }); let count = 0; const tokens: string[] = [];
  const session = new MemorySessionStore(); session.replace(authPayload());
  const client = new ApiClient({ baseUrl: "https://api.test", session, now: () => Date.parse("2030-01-01T00:00:00Z"), transport: async (r) => {
    if (r.url.endsWith("/auth/refresh")) return { status: 200, data: { data: authPayload("refreshed") } };
    return downloadImage(r, r.download!, files, { download: async () => { tokens.push(r.headers.Authorization); return { status: ++count === 1 ? 401 : 200, path: `wxfile://${count}`, mime: "image/png" }; }, read: () => png });
  } });
  assert.deepEqual(await client.downloadMedia(9, { mime: "image/png", size: png.length }), { tempFilePath: "wxfile://2" }); assert.deepEqual(tokens, ["Bearer access-1", "Bearer refreshed"]); assert.deepEqual(removed, ["wxfile://1"]);
  const response = await downloadImage(request, { mime: "image/png", size: png.length }, files, { download: async () => ({ status: 403, path: "wxfile://forbidden", mime: "application/json" }), read: () => { throw new Error("must not read an error as image"); } }); assert.equal(response.status, 403); assert.ok(removed.includes("wxfile://forbidden")); files.clear();
});

const intent = (id: number, status = "pending"): PaymentIntent => ({ order: { id, kind: "pro", status, amountCents: 2990, currency: "CNY", expiresAt: "2030-01-01T00:30:00Z" }, requestPayment: { timeStamp: "1", nonceStr: "nonce", package: "prepay", signType: "RSA", paySign: "signature" } });

test("native payment cancellation/foreground return recovers the same order, then new purchase is new action", async () => {
  let creates = 0; let pays = 0; let paid = false;
  const recovery = new PaymentRecovery({ create: async () => intent(++creates), get: async (id) => intent(id, paid ? "paid" : "pending"), pay: async () => { if (++pays === 1) throw new Error("cancelled"); paid = true; }, now: () => Date.parse("2030-01-01T00:00:00Z"), wait: async () => undefined });
  await assert.rejects(recovery.start("pro")); assert.equal(recovery.orderId(), 1);
  assert.equal((await recovery.start("pro")).order.id, 1); assert.equal(creates, 1); assert.equal(recovery.orderId(), null);
  await recovery.start("pro"); assert.equal(creates, 2);
});

test("logout during native payment drops pending state and prevents late polling into another account", async () => {
  let finish!: () => void; let opened!: () => void; let gets = 0;
  const seen = new Promise<void>((resolve) => { opened = resolve; });
  const recovery = new PaymentRecovery({ create: async () => intent(1), get: async (id) => { gets++; return intent(id, "paid"); }, pay: () => { opened(); return new Promise<void>((resolve) => { finish = resolve; }); }, now: Date.now, wait: async () => undefined });
  const paying = recovery.start("pro"); await seen; recovery.clear(); finish(); await assert.rejects(paying); assert.equal(recovery.orderId(), null); assert.equal(gets, 0);
});
