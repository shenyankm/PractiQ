import assert from "node:assert/strict";
import test from "node:test";
import { ApiClient, ApiClientError, type Transport, type TransportRequest, type TransportResponse } from "../src/api/client";
import { createApi } from "../src/api/modules";
import { MemorySessionStore } from "../src/auth/session";
import { ViewAccess } from "../src/auth/view-access";
import { clearBusinessStorage } from "../src/cache/cleanup";
import { authPayload } from "./fixtures";

const now = Date.parse("2030-01-01T00:00:00Z");
const ok = (data: unknown = {}) => ({ status: 200, data: { data } });
const fail = (status: number, code = "FAIL") => ({ status, data: { error: { code, message: code } } });
function setup(transport: Transport) {
  const session = new MemorySessionStore(); session.replace(authPayload());
  const views = new ViewAccess();
  session.onReset(() => views.invalidate("session"));
  let redirects = 0;
  const client = new ApiClient({ baseUrl: "https://api.test", transport, session, now: () => now, readEpoch: views.readEpoch, onAccessFailure: (kind) => views.invalidate(kind), onUnauthenticated: () => { redirects++; } });
  return { client, session, views, redirects: () => redirects };
}
const stale = (error: unknown) => error instanceof ApiClientError && error.code === "STALE_RESPONSE";

for (const method of ["POST", "PATCH", "PUT", "DELETE"] as const) {
  test(`${method}: unknown outcome retries same user/route/body/key, success starts a new action`, async () => {
    const calls: TransportRequest[] = []; let attempt = 0;
    const { client } = setup(async (request) => { calls.push(request); if (++attempt === 1) throw new Error("lost response"); return { status: 204 }; });
    await assert.rejects(client.request("/api/v1/banks/9", { method, body: { name: "same" } }));
    await client.request("/api/v1/banks/9", { method, body: { name: "same" } });
    await client.request("/api/v1/banks/9", { method, body: { name: "same" } });
    assert.equal(calls[0].headers["Idempotency-Key"], calls[1].headers["Idempotency-Key"]);
    assert.notEqual(calls[1].headers["Idempotency-Key"], calls[2].headers["Idempotency-Key"]);
    assert.deepEqual(calls[0].body, calls[1].body);
    assert.equal(calls[0].headers.Authorization, calls[1].headers.Authorization);
  });
}

for (const [status, code, retain] of [[503, "IDEMPOTENCY_UNAVAILABLE", true], [409, "REQUEST_IN_PROGRESS", true], [422, "VALIDATION_ERROR", false], [404, "NOT_FOUND", false], [409, "IDEMPOTENCY_KEY_REUSED", false], [200, "INVALID_RESPONSE", true]] as const) {
  test(`write outcome ${status}/${code}: ${retain ? "retain" : "finish"} attempt`, async () => {
    const keys: string[] = []; let count = 0;
    const { client } = setup(async (r) => { keys.push(r.headers["Idempotency-Key"]); return ++count === 1 ? fail(status, code) : ok(); });
    await assert.rejects(client.request("/api/v1/questions/9/answer-key", { method: "PUT", body: { value: "A" } }));
    await client.request("/api/v1/questions/9/answer-key", { method: "PUT", body: { value: "A" } });
    assert.equal(keys[0] === keys[1], retain);
  });
}

test("401 refresh snapshots original body and key, not a mutated caller object", async () => {
  const calls: TransportRequest[] = []; const body = { name: "original" }; let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { client } = setup(async (r) => {
    if (r.url.endsWith("/auth/refresh")) { await gate; return ok(authPayload("new")); }
    calls.push(r); return calls.length === 1 ? fail(401) : ok();
  });
  const request = client.request("/api/v1/banks", { method: "POST", body });
  body.name = "edited while refreshing"; release(); await request;
  assert.deepEqual(calls.map((c) => c.body), [{ name: "original" }, { name: "original" }]);
  assert.equal(calls[0].headers["Idempotency-Key"], calls[1].headers["Idempotency-Key"]);
  assert.equal(calls[1].headers.Authorization, "Bearer new");
});

test("concurrent clicks share only an unresolved attempt; route/body/account identities stay separate", async () => {
  const calls: TransportRequest[] = []; let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const { client, session } = setup(async (r) => { calls.push(r); await wait; return ok(); });
  const requests = [client.request("/a", { method: "POST", body: { n: 1 } }), client.request("/a", { method: "POST", body: { n: 1 } }), client.request("/b", { method: "POST", body: { n: 1 } }), client.request("/a", { method: "POST", body: { n: 2 } })];
  release(); await Promise.all(requests); assert.equal(calls.length, 3);
  assert.equal(new Set(calls.map((r) => r.headers["Idempotency-Key"])).size, 3);
  const old = client.scoped(session.getGeneration()); session.replace({ ...authPayload(), user: { ...authPayload().user, id: 8 } });
  await assert.rejects(old.request("/a", { method: "POST", body: {} }), stale);
  assert.equal(calls.length, 3);
});

for (const status of [200, 401, 403]) {
  test(`late ${status} response cannot expose data or invalidate a replacement account`, async () => {
    let resolve!: (value: TransportResponse) => void; let started!: () => void;
    const seen = new Promise<void>((r) => { started = r; });
    const { client, session } = setup(() => { started(); return new Promise((r) => { resolve = r; }); });
    const request = client.request("/api/v1/questions/9"); await seen;
    session.replace({ ...authPayload("other"), user: { ...authPayload().user, id: 8 } });
    resolve(status === 200 ? ok({ stem: "secret" }) : fail(status));
    await assert.rejects(request, stale); assert.equal(session.getSnapshot()?.user.id, 8);
  });
}

test("late refresh cannot restore a logged-out or replacement session", async () => {
  let resolve!: (value: TransportResponse) => void; let started!: () => void;
  const seen = new Promise<void>((r) => { started = r; });
  const { client, session } = setup(() => { started(); return new Promise((r) => { resolve = r; }); });
  session.replace(authPayload("old", "refresh", "2030-01-01T00:00:01Z"));
  const request = client.request("/resource"); await seen; session.clear(); session.replace(authPayload("replacement")); resolve(ok(authPayload("late")));
  await assert.rejects(request, stale); assert.equal(session.getSnapshot()?.tokens.accessToken, "replacement");
});

test("all upload wrappers use normal 401 refresh/invalidation and manual-retry keys", async () => {
  const calls: TransportRequest[] = []; let uploadCalls = 0;
  const { client, session, redirects } = setup(async (r) => {
    if (r.url.endsWith("/auth/refresh")) return ok(authPayload("rotated"));
    calls.push(r); uploadCalls++;
    if (uploadCalls === 1) return fail(401);
    if (uploadCalls === 2) throw new Error("lost upload response");
    return ok({ id: 3 });
  });
  const api = createApi(client);
  await assert.rejects(api.media.upload("/tmp/file.png")); await api.media.upload("/tmp/file.png");
  assert.equal(new Set(calls.map((c) => c.headers["Idempotency-Key"])).size, 1);
  assert.ok(calls.every((c) => c.uploadFilePath === "/tmp/file.png" && !c.headers["Content-Type"]));
  await api.imports.upload(4, "/tmp/file.pdf"); await api.admin.knowledgeImport("/tmp/file.csv");
  assert.ok(calls.every((c) => Boolean(c.headers["Idempotency-Key"])));
  assert.equal(session.getSnapshot()?.tokens.accessToken, "rotated"); assert.equal(redirects(), 0);
  const invalid = setup(async (r) => r.url.endsWith("/auth/refresh") ? ok(authPayload("new")) : fail(401));
  await assert.rejects(createApi(invalid.client).media.upload("/tmp/file")); assert.equal(invalid.session.getSnapshot(), null); assert.equal(invalid.redirects(), 1);
});

test("current read denial clears content, expected write 4xx only requests revalidation", async () => {
  const { client, views } = setup(async () => fail(404, "NOT_FOUND")); const events: string[] = []; views.subscribe((event) => events.push(event));
  await assert.rejects(client.request("/api/v1/practice-sessions/9/complete", { method: "POST" })); assert.deepEqual(events, ["revalidate"]);
  await assert.rejects(client.request("/api/v1/practice-sessions/9")); assert.deepEqual(events, ["revalidate", "permission"]);
});

test("storage cleanup is user-scoped; failures still revoke memory and block new login", () => {
  const keys = new Set(["practiq:v2:7:analytics", "practiq:v2:8:bank", "privacy-consent"]);
  const storage = { keys: () => [...keys], remove: (key: string) => { keys.delete(key); } };
  const session = new MemorySessionStore(); session.replace(authPayload()); session.onReset((previous) => { if (previous) clearBusinessStorage(storage, previous.user.id); }); session.clear();
  assert.deepEqual([...keys], ["practiq:v2:8:bank", "privacy-consent"]); clearBusinessStorage(storage); assert.deepEqual([...keys], ["privacy-consent"]);
  session.replace(authPayload()); session.onReset(() => { throw new Error("storage unavailable"); });
  assert.throws(() => session.replace(authPayload("new"))); assert.equal(session.getSnapshot(), null);
});

test("payment creation keeps 30-minute admission lifetime, refund/auth do not use ordinary keys", async () => {
  let clock = now; const keys: Array<string | undefined> = [];
  const session = new MemorySessionStore(); session.replace(authPayload("old", "r", "2030-01-02T00:00:00Z"));
  const client = new ApiClient({ baseUrl: "https://api.test", session, now: () => clock, transport: async (r) => { keys.push(r.headers["Idempotency-Key"]); return fail(503); } });
  const api = createApi(client);
  await assert.rejects(api.payments.create("pro")); clock += 29 * 60_000; await assert.rejects(api.payments.create("pro")); assert.equal(keys[0], keys[1]);
  clock += 2 * 60_000; await assert.rejects(api.payments.create("pro")); assert.notEqual(keys[1], keys[2]);
  await assert.rejects(api.payments.refund(9)); assert.equal(keys[3], undefined);
});
