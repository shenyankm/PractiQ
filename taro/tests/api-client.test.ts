import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ApiClient,
  ApiClientError,
  type Transport,
  type TransportRequest,
} from "../src/api/client";
import { MemorySessionStore } from "../src/auth/session";
import { loginWithWeChat } from "../src/auth/wechat";
import { authPayload } from "./fixtures";

const now = Date.parse("2030-01-01T00:00:00.000Z");

function clientWith(
  transport: Transport,
  session = new MemorySessionStore(),
  onUnauthenticated: () => void = () => undefined,
): { client: ApiClient; session: MemorySessionStore } {
  return {
    client: new ApiClient({
      baseUrl: "https://api.example.test",
      transport,
      session,
      now: () => now,
      onUnauthenticated,
    }),
    session,
  };
}

test("WeChat login sends only the temporary code and stores a successful session", async () => {
  let request: TransportRequest | undefined;
  const payload = authPayload();
  const { client, session } = clientWith(async (value) => {
    request = value;
    return { status: 200, data: { data: payload, meta: null } };
  });

  await loginWithWeChat(client, { login: async () => ({ code: "wx-code" }) });

  assert.equal(request?.url, "https://api.example.test/api/v1/auth/wechat-login");
  assert.equal(request?.method, "POST");
  assert.deepEqual(request?.body, { code: "wx-code" });
  assert.equal(session.getSnapshot()?.tokens.accessToken, "access-1");
});

test("login surfaces WeChat and backend failures without creating a session", async () => {
  const { client, session } = clientWith(async () => ({
    status: 409,
    data: { error: { code: "IDENTITY_CONFLICT", message: "身份冲突" } },
  }));

  await assert.rejects(
    () => loginWithWeChat(client, { login: async () => Promise.reject(new Error("denied")) }),
    (error: unknown) => error instanceof ApiClientError && error.code === "WECHAT_LOGIN_FAILED",
  );
  await assert.rejects(
    () => loginWithWeChat(client, { login: async () => ({ code: "" }) }),
    (error: unknown) => error instanceof ApiClientError && error.code === "WECHAT_LOGIN_FAILED",
  );
  await assert.rejects(
    () => loginWithWeChat(client, { login: async () => ({ code: "conflict" }) }),
    (error: unknown) => error instanceof ApiClientError && error.code === "IDENTITY_CONFLICT",
  );
  assert.equal(session.getSnapshot(), null);

  const offline = clientWith(async () => Promise.reject(new Error("offline")));
  await assert.rejects(
    () => loginWithWeChat(offline.client, { login: async () => ({ code: "network" }) }),
    (error: unknown) => error instanceof ApiClientError && error.code === "NETWORK_ERROR",
  );
  assert.equal(offline.session.getSnapshot(), null);
});

test("bank requests encode an opaque cursor and require pagination metadata", async () => {
  const store = new MemorySessionStore();
  store.replace(authPayload());
  let requestedUrl = "";
  const { client } = clientWith(async (request) => {
    requestedUrl = request.url;
    return {
      status: 200,
      data: {
        data: [],
        meta: { pagination: { cursor: "", limit: 30, hasMore: false } },
      },
    };
  }, store);

  const page = await client.getBanks("favorites", "opaque+/=", 30);
  assert.equal(
    requestedUrl,
    "https://api.example.test/api/v1/banks?scope=favorites&limit=30&cursor=opaque%2B%2F%3D",
  );
  assert.deepEqual(page, {
    items: [],
    pagination: { cursor: "", limit: 30, hasMore: false },
  });
});

test("near-expiry concurrent requests share one refresh and use the replacement token", async () => {
  const store = new MemorySessionStore();
  store.replace(authPayload("old", "refresh-old", "2030-01-01T00:00:10.000Z"));
  let refreshCalls = 0;
  const resourceTokens: string[] = [];
  let releaseRefresh: (() => void) | undefined;
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });

  const transport: Transport = async (request) => {
    if (request.url.endsWith("/auth/refresh")) {
      refreshCalls += 1;
      await refreshGate;
      return { status: 200, data: { data: authPayload("new", "refresh-new") } };
    }
    resourceTokens.push(request.headers.Authorization);
    return { status: 200, data: { data: { ok: true } } };
  };
  const { client } = clientWith(transport, store);

  const first = client.request<{ ok: boolean }>("/resource-a");
  const second = client.request<{ ok: boolean }>("/resource-b");
  await Promise.resolve();
  releaseRefresh?.();
  await Promise.all([first, second]);

  assert.equal(refreshCalls, 1);
  assert.deepEqual(resourceTokens, ["Bearer new", "Bearer new"]);
  assert.equal(store.getSnapshot()?.tokens.refreshToken, "refresh-new");
});

test("the first 401 refreshes once and retries with the new access token", async () => {
  const store = new MemorySessionStore();
  store.replace(authPayload("old"));
  let resourceCalls = 0;
  let refreshCalls = 0;
  const { client } = clientWith(async (request) => {
    if (request.url.endsWith("/auth/refresh")) {
      refreshCalls += 1;
      return { status: 200, data: { data: authPayload("new", "next-refresh") } };
    }
    resourceCalls += 1;
    if (resourceCalls === 1) {
      return { status: 401, data: { error: { code: "UNAUTHENTICATED", message: "expired" } } };
    }
    assert.equal(request.headers.Authorization, "Bearer new");
    return { status: 200, data: { data: { ok: true } } };
  }, store);

  assert.deepEqual(await client.request("/resource"), { ok: true });
  assert.equal(resourceCalls, 2);
  assert.equal(refreshCalls, 1);
});

test("a second 401 never loops and clears the session", async () => {
  const store = new MemorySessionStore();
  store.replace(authPayload("old"));
  let resourceCalls = 0;
  let refreshCalls = 0;
  let redirects = 0;
  const { client } = clientWith(async (request) => {
    if (request.url.endsWith("/auth/refresh")) {
      refreshCalls += 1;
      return { status: 200, data: { data: authPayload("new", "next-refresh") } };
    }
    resourceCalls += 1;
    return { status: 401, data: { error: { code: "UNAUTHENTICATED", message: "no" } } };
  }, store, () => {
    redirects += 1;
  });

  await assert.rejects(
    () => client.request("/resource"),
    (error: unknown) => error instanceof ApiClientError && error.status === 401,
  );
  assert.equal(resourceCalls, 2);
  assert.equal(refreshCalls, 1);
  assert.equal(redirects, 1);
  assert.equal(store.getSnapshot(), null);
});

test("refresh failure and inactive users clear the session", async () => {
  for (const failure of [
    { status: 401, code: "INVALID_REFRESH_TOKEN" },
    { status: 403, code: "USER_INACTIVE" },
  ]) {
    const store = new MemorySessionStore();
    store.replace(authPayload("old", "refresh-old", "2030-01-01T00:00:01.000Z"));
    let redirects = 0;
    const { client } = clientWith(async () => ({
      status: failure.status,
      data: { error: { code: failure.code, message: "登录失效" } },
    }), store, () => {
      redirects += 1;
    });

    await assert.rejects(() => client.request("/resource"));
    assert.equal(store.getSnapshot(), null);
    assert.equal(redirects, 1);
  }
});

test("logout clears memory and redirects even when the backend cannot be notified", async () => {
  const store = new MemorySessionStore();
  store.replace(authPayload());
  let redirects = 0;
  const { client } = clientWith(async () => Promise.reject(new Error("offline")), store, () => {
    redirects += 1;
  });

  await client.logout();

  assert.equal(store.getSnapshot(), null);
  assert.equal(redirects, 1);
});
