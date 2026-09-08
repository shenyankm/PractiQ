import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import React, { useEffect, useState, type ComponentType } from "react";
import { ApiClient, type TransportResponse } from "../src/api/client";
import { createApi } from "../src/api/modules";
import { MemorySessionStore } from "../src/auth/session";
import { ViewAccess, PageValidation } from "../src/auth/view-access";
import { authPayload } from "./fixtures";
import { reactHost } from "./react-host";

function harness(loggedIn = true) {
  const session = new MemorySessionStore(); if (loggedIn) session.replace(authPayload());
  const views = new ViewAccess(); session.onReset(() => views.invalidate("session"));
  const show = new Set<() => void>(); const hide = new Set<() => void>();
  let redirects = 0; let reads = 0; let resource: () => Promise<TransportResponse> = async () => ({ status: 200, data: { data: "old-bank-content" } });
  const client = new ApiClient({ baseUrl: "https://api.test", session, now: () => Date.parse("2030-01-01T00:00:00Z"), readEpoch: views.readEpoch, onAccessFailure: (kind) => views.invalidate(kind), transport: async (request) => {
    if (request.url.endsWith("/auth/me")) return { status: 200, data: { data: authPayload().user } };
    reads++; return resource();
  } });
  const hook = (listeners: Set<() => void>, callback: () => void) => useEffect(() => { listeners.add(callback); return () => { listeners.delete(callback); }; }, [callback]);
  const source = ts.transpileModule(readFileSync(path.resolve(__dirname, "../src/auth/protected-page.tsx"), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  const load = (id: string): unknown => {
    if (id === "@tarojs/components") return { View: "View", Button: "Button", Text: "Text" };
    if (id === "@tarojs/taro") return { useDidShow: (cb: () => void) => hook(show, cb), useDidHide: (cb: () => void) => hook(hide, cb), reLaunch: () => { redirects++; } };
    if (id === "../api") return { apiClient: client };
    if (id === "../api/modules") return { createApi };
    if (id === "./session") return { sessionStore: session };
    if (id === "./view-access") return { viewAccess: views, PageValidation };
    if (id === "react") return React;
    if (id === "react/jsx-runtime") return require("react/jsx-runtime") as unknown;
    throw new Error(`Unexpected test import: ${id}`);
  };
  new Function("require", "module", "exports", source)(load, module, module.exports);
  const { protectedPage, usePageLoad } = module.exports as { protectedPage(component: ComponentType): ComponentType; usePageLoad(load: () => Promise<void>): void };
  let setDraft: (value: string) => void = () => undefined; let mounts = 0; let unmounts = 0;
  function Content() {
    const [data, setData] = useState(""); const [draft, updateDraft] = useState(""); setDraft = updateDraft;
    useEffect(() => { mounts++; return () => { unmounts++; }; }, []);
    usePageLoad(async () => { try { setData(await client.request<string>("/api/v1/banks/9")); } catch { /* actual pages show a safe boundary on API failures */ } });
    return React.createElement("Text", null, `${data}|draft:${draft}`);
  }
  const host = reactHost(); host.render(React.createElement(protectedPage(Content)));
  return { host, session, views, setDraft: (value: string) => setDraft(value), setResource: (value: typeof resource) => { resource = value; }, show: () => [...show].forEach((cb) => cb()), hide: () => [...hide].forEach((cb) => cb()), reads: () => reads, redirects: () => redirects, mounts: () => mounts, unmounts: () => unmounts };
}

test("actual protected page: cold subpackage entry redirects without mounting business content", async () => {
  const app = harness(false); await app.host.flush(); assert.equal(app.mounts(), 0); assert.equal(app.reads(), 0); assert.ok(app.redirects() > 0); app.host.render(null); await app.host.flush();
});

test("actual protected page: hide/chooser/payment return preserves draft but reloads before exposing content", async () => {
  const app = harness(); await app.host.flush(); assert.match(app.host.text(), /old-bank-content/);
  app.setDraft("unsaved input"); await app.host.flush(); app.hide(); await app.host.flush(); assert.doesNotMatch(app.host.text(), /old-bank-content|unsaved input/);
  let resolve!: (value: TransportResponse) => void;
  app.setResource(() => new Promise((r) => { resolve = r; })); const before = app.reads(); app.show(); await app.host.flush();
  assert.ok(app.reads() > before); assert.doesNotMatch(app.host.text(), /old-bank-content|unsaved input/);
  resolve({ status: 200, data: { data: "fresh-bank-content" } }); await app.host.flush();
  assert.match(app.host.text(), /fresh-bank-content\|draft:unsaved input/); assert.equal(app.mounts(), 1);
  app.host.render(null); await app.host.flush();
});

for (const status of [403, 404]) {
  test(`actual protected page: ${status} destroys server content and draft, never retry-loops`, async () => {
    const app = harness(); await app.host.flush(); app.setDraft("old input"); app.setResource(async () => ({ status, data: { error: { code: "NOT_FOUND", message: "revoked" } } }));
    app.show(); await app.host.flush(); assert.doesNotMatch(app.host.text(), /old-bank-content|old input/); assert.equal(app.unmounts(), 1);
    const reads = app.reads(); await app.host.flush(); assert.equal(app.reads(), reads);
    app.setResource(async () => ({ status: 200, data: { data: "restored" } })); app.host.clickRetry(); await app.host.flush();
    assert.match(app.host.text(), /restored\|draft:/); assert.doesNotMatch(app.host.text(), /old input/); app.host.render(null); await app.host.flush();
  });
}

test("actual protected page: offline hides old content, logout destroys it even with outstanding reads", async () => {
  const app = harness(); await app.host.flush(); app.setDraft("private draft"); app.views.invalidate("offline"); await app.host.flush();
  assert.doesNotMatch(app.host.text(), /old-bank-content|private draft/); assert.equal(app.unmounts(), 0);
  app.session.clear(); await app.host.flush(); assert.equal(app.unmounts(), 1); assert.ok(app.redirects() > 0); app.host.render(null); await app.host.flush();
});
