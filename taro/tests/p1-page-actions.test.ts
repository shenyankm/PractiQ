import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import React, { useEffect } from "react";
import { reactHost } from "./react-host";
import { PendingTransfers } from "../src/transfers/pending-transfers";
import { isRetryableWriteError } from "../src/api/client";

function page(
  name: string,
  api: unknown,
  routes: Record<string, number> = {},
  transfers = new PendingTransfers(),
) {
  const loaders = new Set<() => Promise<unknown>>();
  const navigations: string[] = [];
  const module = { exports: {} };
  const js = ts.transpileModule(
    readFileSync(path.resolve(__dirname, "../src", name), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
    },
  ).outputText;
  const load = (id: string): unknown => {
    if (id.endsWith("/auth/protected-page"))
      return {
        protectedPage: (content: unknown) => content,
        usePageApi: () => api,
        usePageLoad: (loader: () => Promise<unknown>) =>
          useEffect(() => {
            loaders.add(loader);
            return () => {
              loaders.delete(loader);
            };
          }, [loader]),
      };
    if (id === "react") return React;
    if (id === "react/jsx-runtime")
      return require("react/jsx-runtime") as unknown;
    if (id === "@taroify/core") return { Button: "Button", Switch: "Switch" };
    if (id === "@tarojs/components")
      return {
        Input: "Input",
        Picker: "Picker",
        Text: "Text",
        Textarea: "Textarea",
        View: "View",
      };
    if (id === "@tarojs/taro")
      return {
        chooseMessageFile: async () => ({
          tempFiles: [{ path: "/tmp/original.pdf", name: "original.pdf" }],
        }),
        redirectTo: async ({ url }: { url: string }) => {
          navigations.push(url);
        },
        navigateBack: async () => undefined,
      };
    if (id.endsWith("/transfers/runtime"))
      return {
        pendingTransfers: transfers,
        identifyTransferFile: async (path: string, name: string) => ({
          path,
          name,
          digest: "fixed-digest",
          size: 100,
        }),
        verifyTransferFile: async () => undefined,
      };
    if (id.endsWith("/components/ui"))
      return {
        confirmDanger: async () => true,
        ErrorNotice: "ErrorNotice",
        Page: "Page",
        PageHeader: "PageHeader",
        Section: "Section",
      };
    if (id.endsWith("/api/message"))
      return { errorMessage: (error: Error) => error.message };
    if (id.endsWith("/api/client")) return { isRetryableWriteError };
    if (id.endsWith("/navigation"))
      return { routeNumber: (key: string) => routes[key] ?? null };
    if (id.endsWith("/hooks/useTaskPolling"))
      return { useTaskPolling: () => ({ task: null }) };
    throw new Error(`Unexpected page import ${id}`);
  };
  new Function("require", "module", "exports", js)(
    load,
    module,
    module.exports,
  );
  const host = reactHost();
  host.render(
    React.createElement(
      (module.exports as { default: React.ComponentType }).default,
    ),
  );
  return {
    host,
    navigations,
    async refresh() {
      await host.flush();
      await Promise.all([...loaders].map((loader) => loader()));
      await host.flush();
    },
    input(type: string, index: number, value: string) {
      (host.nodes(type)[index].props.onInput as (event: unknown) => void)({
        detail: { value },
      });
    },
    click(index: number) {
      (host.nodes("Button")[index].props.onClick as () => void)();
    },
  };
}

test("actual owner question editor uses management, preserves typed stem, refreshes unedited server analysis", async () => {
  let stem = "server stem";
  let analysis = "old server analysis";
  let calls = 0;
  const app = page(
    "packages/content/questions/edit/index.tsx",
    {
      references: { subjects: async () => [], questionTypes: async () => [] },
      questions: {
        get: async () => {
          throw new Error("learning endpoint must not be used");
        },
        management: async () => {
          calls++;
          return {
            stem,
            analysis,
            question_type_id: "short",
            answer_mode: "short_answer",
            options: [],
          };
        },
      },
      aiTasks: { get: async () => undefined },
    },
    { id: 9 },
  );
  await app.refresh();
  app.input("Textarea", 0, "unsaved user stem");
  await app.host.flush();
  stem = "new server stem";
  analysis = "new server analysis";
  await app.refresh();
  assert.equal(app.host.nodes("Textarea")[0].props.value, "unsaved user stem");
  assert.equal(
    app.host.nodes("Textarea")[1].props.value,
    "new server analysis",
  );
  assert.equal(calls, 2);
  app.host.render(null);
  await app.host.flush();
});

test("actual owner bank editor retains only edited fields across foreground validation", async () => {
  let description = "old description";
  const app = page(
    "packages/content/banks/edit/index.tsx",
    {
      references: {
        subjects: async () => [
          { subject_id: "general", display_name: "General" },
        ],
      },
      banks: {
        get: async () => ({
          name: "server name",
          description,
          subject_id: "general",
          status: "private",
        }),
        tags: async () => [],
      },
    },
    { id: 4 },
  );
  await app.refresh();
  app.input("Input", 0, "user bank name");
  await app.host.flush();
  description = "fresh description";
  await app.refresh();
  assert.equal(app.host.nodes("Input")[0].props.value, "user bank name");
  assert.equal(app.host.nodes("Textarea")[0].props.value, "fresh description");
  app.host.render(null);
  await app.host.flush();
});

test("actual import page restores an initiated operation after navigateBack/remount, without another create", async () => {
  const calls: string[] = [];
  const uploadKeys: Array<string | undefined> = [];
  let uploads = 0;
  const transfers = new PendingTransfers();
  const api = {
    banks: {
      list: async () => ({ items: [{ id: 4, name: "Owned" }] }),
      get: async () => ({ id: 4 }),
    },
    imports: {
      get: async (id: number) => ({ id, bank_id: 4, status: "queued" }),
      create: async () => {
        calls.push("create");
        return { id: 91 };
      },
      upload: async (id: number, file: string, key?: string) => {
        calls.push(`upload:${id}:${file}`);
        uploadKeys.push(key);
        if (++uploads === 1) throw new Error("network failure");
        return { id };
      },
      action: async (id: number) => {
        calls.push(`parse:${id}`);
        return { id };
      },
    },
  };
  const app = page(
    "packages/tools/imports/create/index.tsx",
    api,
    {},
    transfers,
  );
  await app.refresh();
  app.click(0);
  await app.host.flush();
  await app.refresh();
  assert.match(app.host.text(), /original.pdf/);
  app.click(1);
  await app.host.flush();
  assert.deepEqual(calls, ["create", "upload:91:/tmp/original.pdf"]);
  app.host.render(null);
  await app.host.flush();
  const reopened = page(
    "packages/tools/imports/create/index.tsx",
    api,
    {},
    transfers,
  );
  await reopened.refresh();
  assert.match(reopened.host.text(), /任务 #91/);
  assert.match(reopened.host.text(), /original.pdf/);
  reopened.click(1);
  await reopened.host.flush();
  assert.deepEqual(calls, [
    "create",
    "upload:91:/tmp/original.pdf",
    "upload:91:/tmp/original.pdf",
    "parse:91",
  ]);
  assert.ok(uploadKeys[0]);
  assert.equal(uploadKeys[0], uploadKeys[1]);
  assert.deepEqual(reopened.navigations, [
    "/packages/tools/imports/detail/index?id=91",
  ]);
  assert.equal(transfers.importFor(transfers.scope(), 4), undefined);
  reopened.host.render(null);
  await reopened.host.flush();
});

test("actual media editor remount resumes a known asset link instead of opening another file picker/upload", async () => {
  const transfers = new PendingTransfers();
  let uploads = 0;
  let links = 0;
  const keys: Array<string | undefined> = [];
  const api = {
    references: { subjects: async () => [] },
    questions: {
      management: async () => ({
        id: 9,
        stem: "stem",
        analysis: "analysis",
        question_type_id: "short",
        answer_mode: "short_answer",
        options: [],
      }),
    },
    aiTasks: { get: async () => undefined },
    media: {
      get: async () => ({ id: 22, mime_type: "image/png" }),
      upload: async () => {
        uploads++;
        return { id: 22 };
      },
      linkQuestion: async (
        _question: number,
        _media: number,
        _kind: string,
        _order: number,
        key?: string,
      ) => {
        keys.push(key);
        if (++links === 1) throw new Error("lost link response");
      },
    },
  };
  const app = page(
    "packages/content/questions/edit/index.tsx",
    api,
    { id: 9 },
    transfers,
  );
  await app.refresh();
  app.click(1);
  await app.host.flush();
  assert.equal(uploads, 1);
  assert.equal(links, 1);
  app.host.render(null);
  await app.host.flush();
  const reopened = page(
    "packages/content/questions/edit/index.tsx",
    api,
    { id: 9 },
    transfers,
  );
  await reopened.refresh();
  assert.match(reopened.host.text(), /继续原媒体操作/);
  reopened.click(1);
  await reopened.host.flush();
  assert.equal(uploads, 1);
  assert.equal(links, 2);
  assert.ok(keys[0]);
  assert.equal(keys[0], keys[1]);
  assert.equal(transfers.mediaFor(transfers.scope(), 9), undefined);
  reopened.host.render(null);
  await reopened.host.flush();
});

test("late import restoration cannot replace the file parameters of a newly selected target bank", async () => {
  const transfers = new PendingTransfers();
  const scope = transfers.scope();
  transfers.beginImport(scope, 4, {
    path: "/tmp/a.pdf",
    name: "a.pdf",
    digest: "a",
    size: 10,
  });
  transfers.beginImport(scope, 5, {
    path: "/tmp/b.pdf",
    name: "b.pdf",
    digest: "b",
    size: 20,
  });
  let release!: () => void;
  const app = page(
    "packages/tools/imports/create/index.tsx",
    {
      banks: {
        list: async () => ({
          items: [
            { id: 4, name: "A" },
            { id: 5, name: "B" },
          ],
        }),
        get: async (id: number) => {
          if (id === 4)
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          return { id };
        },
      },
    },
    {},
    transfers,
  );
  await app.refresh();
  const select = (index: number) =>
    (app.host.nodes("Picker")[0].props.onChange as (event: unknown) => void)({
      detail: { value: index },
    });
  select(0);
  await app.host.flush();
  select(1);
  await app.host.flush();
  release();
  await app.host.flush();
  assert.match(app.host.text(), /b.pdf/);
  assert.doesNotMatch(app.host.text(), /a.pdf/);
  app.host.render(null);
  await app.host.flush();
});
