import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  ApiClient,
  ApiClientError,
  type TransportRequest,
  type TransportResponse,
} from "../src/api/client";
import { createApi } from "../src/api/modules";
import { MemorySessionStore } from "../src/auth/session";
import { ViewAccess } from "../src/auth/view-access";
import {
  PendingTransfers,
  type TransferFile,
} from "../src/transfers/pending-transfers";
import { authPayload } from "./fixtures";

const file: TransferFile = {
  path: "/tmp/original.pdf",
  name: "original.pdf",
  digest: "original-digest",
  size: 100,
};
const now = Date.parse("2030-01-01T00:00:00Z");
const ok = (data: unknown): TransportResponse => ({
  status: 200,
  data: { data },
});
const verify = async (value: TransferFile) => {
  assert.deepEqual(value, file);
};
function fixture(
  handler: (request: TransportRequest) => Promise<TransportResponse>,
) {
  const calls: TransportRequest[] = [];
  const session = new MemorySessionStore();
  session.replace(authPayload());
  const views = new ViewAccess();
  const client = new ApiClient({
    baseUrl: "https://api.test",
    session,
    now: () => now,
    readEpoch: views.readEpoch,
    onAccessFailure: (event) => views.invalidate(event),
    transport: async (request) => {
      calls.push(request);
      return handler(request);
    },
  });
  const transfers = new PendingTransfers(
    (keys) => {
      void client.forgetWriteKeys(keys);
    },
    () => now,
  );
  session.onReset(() => views.invalidate("session"));
  views.subscribe((event) => {
    if (event === "session" || event === "permission") transfers.clear();
  });
  return { transfers, api: createApi(client), calls, session, views };
}

for (const lostResponse of [false, true]) {
  test(`import resume reauthorizes and checks known job; upload ${lostResponse ? "committed response lost" : "not committed"} never repeats create`, async () => {
    let uploads = 0;
    let uploaded = false;
    const f = fixture(async (r) => {
      if (r.url.endsWith("/banks/4")) return ok({ id: 4 });
      if (r.url.endsWith("/import-jobs") && r.method === "POST")
        return ok({ id: 91 });
      if (r.url.endsWith("/import-jobs/91"))
        return ok({
          id: 91,
          bank_id: 4,
          status: "queued",
          source_size_bytes: uploaded ? 100 : null,
        });
      if (r.uploadFilePath) {
        uploads++;
        uploaded = lostResponse || uploads > 1;
        if (uploads === 1) throw new Error("lost connection");
        return ok({ id: 91 });
      }
      if (r.url.endsWith("/parse")) return ok({ id: 91, status: "processing" });
      throw new Error(`Unexpected request ${r.url}`);
    });
    const scope = f.transfers.scope();
    const original = f.transfers.beginImport(scope, 4, file);
    await assert.rejects(f.transfers.runImport(f.api, original, verify));
    assert.equal(original.jobId, 91);
    const resumed = f.transfers.importFor(scope, 4)!;
    assert.equal(resumed, original);
    const start = f.calls.length;
    assert.equal(await f.transfers.runImport(f.api, resumed, verify), 91);
    assert.ok(f.calls[start].url.endsWith("/banks/4"));
    assert.ok(f.calls[start + 1].url.endsWith("/import-jobs/91"));
    assert.equal(
      f.calls.filter(
        (r) => r.url.endsWith("/import-jobs") && r.method === "POST",
      ).length,
      1,
    );
    const uploadsSent = f.calls.filter((r) => r.uploadFilePath);
    assert.equal(uploadsSent.length, lostResponse ? 1 : 2);
    assert.ok(
      uploadsSent.every(
        (r) =>
          r.uploadFilePath === file.path &&
          r.headers["Idempotency-Key"] === original.keys.upload,
      ),
    );
    assert.equal(f.transfers.importFor(scope, 4), undefined);
    assert.notEqual(
      f.transfers.beginImport(scope, 4, file).keys.create,
      original.keys.create,
    );
  });
}

test("unknown create outcome replays original parameters and key before looking up the returned job", async () => {
  let creates = 0;
  const f = fixture(async (r) => {
    if (r.url.endsWith("/banks/4")) return ok({ id: 4 });
    if (r.url.endsWith("/import-jobs")) {
      if (++creates === 1) throw new Error("lost create response");
      return ok({ id: 91 });
    }
    if (r.url.endsWith("/import-jobs/91"))
      return ok({ id: 91, bank_id: 4, status: "processing" });
    throw new Error("must not upload or parse an already-started job");
  });
  const attempt = f.transfers.beginImport(f.transfers.scope(), 4, file);
  await assert.rejects(f.transfers.runImport(f.api, attempt, verify));
  assert.equal(attempt.jobId, undefined);
  assert.equal(await f.transfers.runImport(f.api, attempt, verify), 91);
  const writes = f.calls.filter((r) => r.method === "POST");
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0], writes[1]);
});

test("known media resumes link with the same key after reauthorization, without retaining response content or requiring the old file", async () => {
  let links = 0;
  const f = fixture(async (r) => {
    if (r.url.endsWith("/questions/9/management"))
      return ok({ id: 9, analysis: "sensitive management response" });
    if (r.uploadFilePath) return ok({ id: 22, mime_type: "image/png" });
    if (r.url.endsWith("/media/22"))
      return ok({ id: 22, mime_type: "image/png" });
    if (r.url.endsWith("/media-links")) {
      if (++links === 1) throw new Error("lost link response");
      return ok({});
    }
    throw new Error(`Unexpected request ${r.url}`);
  });
  const scope = f.transfers.scope();
  const original = f.transfers.beginMedia(scope, 9, file);
  await assert.rejects(f.transfers.runMedia(f.api, original, verify));
  assert.equal(original.mediaId, 22);
  assert.ok(
    !JSON.stringify(original).includes("sensitive management response"),
  );
  const start = f.calls.length;
  await f.transfers.runMedia(
    f.api,
    f.transfers.mediaFor(scope, 9)!,
    async () => {
      throw new Error("temporary file gone; no upload is needed");
    },
  );
  assert.ok(f.calls[start].url.endsWith("/management"));
  assert.ok(f.calls[start + 1].url.endsWith("/media/22"));
  assert.equal(f.calls.filter((r) => r.uploadFilePath).length, 1);
  const writes = f.calls.filter((r) => r.url.endsWith("/media-links"));
  assert.deepEqual(writes[0], writes[1]);
  assert.equal(f.transfers.mediaFor(scope, 9), undefined);
});

test("missing/changed file fails before writes; replacing a pending file requires ending the local operation and new keys", async () => {
  const f = fixture(async () => ok({ id: 4 }));
  const scope = f.transfers.scope();
  const original = f.transfers.beginImport(scope, 4, file);
  await assert.rejects(
    f.transfers.runImport(f.api, original, async () => {
      throw new Error("原临时文件已丢失或改变");
    }),
    /原临时文件/,
  );
  assert.ok(f.calls.every((r) => r.method === "GET"));
  assert.throws(
    () => f.transfers.beginImport(scope, 4, { ...file, path: "/tmp/new.pdf" }),
    /明确放弃/,
  );
  f.transfers.endImport(original);
  const next = f.transfers.beginImport(scope, 4, {
    ...file,
    path: "/tmp/new.pdf",
  });
  assert.notEqual(next.keys.create, original.keys.create);
  assert.notEqual(next.keys.upload, original.keys.upload);
  assert.ok(
    f.calls.every((r) => !r.url.includes("cancel") && r.method !== "DELETE"),
  );
});

test("expired transfer admission cannot silently create a new task", async () => {
  let clock = now;
  const transfers = new PendingTransfers(undefined, () => clock);
  const pending = transfers.beginImport(transfers.scope(), 4, file);
  clock += 24 * 60 * 60_000;
  const f = fixture(async () => {
    throw new Error("expired attempt must not issue requests");
  });
  await assert.rejects(
    transfers.runImport(f.api, pending, verify),
    /超过重试窗口/,
  );
  assert.equal(f.calls.length, 0);
});

for (const event of ["session", "permission"] as const) {
  test(`${event} clears recovery parameters and prevents an in-flight media upload from starting a link`, async () => {
    let release!: (value: TransportResponse) => void;
    let entered!: () => void;
    const uploading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const f = fixture(async (r) => {
      if (r.url.endsWith("/management")) return ok({ id: 9 });
      entered();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const scope = f.transfers.scope();
    const pending = f.transfers.beginMedia(scope, 9, file);
    f.transfers.beginImport(scope, 4, file);
    const running = f.transfers.runMedia(f.api, pending, verify);
    await uploading;
    if (event === "session")
      f.session.replace({
        ...authPayload(),
        user: { ...authPayload().user, id: 8 },
      });
    else f.views.invalidate("permission");
    release(ok({ id: 22 }));
    await assert.rejects(
      running,
      (error: unknown) =>
        error instanceof ApiClientError && error.code === "STALE_RESPONSE",
    );
    assert.equal(f.transfers.mediaFor(f.transfers.scope(), 9), undefined);
    assert.equal(f.transfers.importFor(f.transfers.scope(), 4), undefined);
    assert.equal(f.calls.length, 2);
    assert.throws(() => f.transfers.beginMedia(scope, 9, file), /变化/);
  });
}

test("deterministic create 4xx ends the attempt; known-resource 4xx blocks blind restart and retains only its receipt", async () => {
  let phase: "create" | "upload" = "create";
  const f = fixture(async (r) => {
    if (r.method === "GET") return ok({ id: 91, bank_id: 4, status: "queued" });
    if (r.url.endsWith("/import-jobs") && phase === "upload")
      return ok({ id: 91 });
    return {
      status: 422,
      data: { error: { code: "VALIDATION_ERROR", message: "invalid" } },
    };
  });
  const scope = f.transfers.scope();
  const first = f.transfers.beginImport(scope, 4, file);
  await assert.rejects(f.transfers.runImport(f.api, first, verify));
  assert.equal(f.transfers.importFor(scope, 4), undefined);
  phase = "upload";
  const second = f.transfers.beginImport(scope, 4, file);
  await assert.rejects(f.transfers.runImport(f.api, second, verify));
  assert.equal(second.jobId, 91);
  assert.equal(second.blocked, true);
  const count = f.calls.length;
  await assert.rejects(
    f.transfers.runImport(f.api, second, verify),
    /明确放弃/,
  );
  assert.equal(f.calls.length, count);
});

test("actual transfer platform verifies file digest/size and clears only on account/permission invalidation", async () => {
  const views = new ViewAccess();
  let info: unknown = { digest: file.digest, size: file.size };
  const forgotten: string[][] = [];
  const module = { exports: {} };
  const source = ts.transpileModule(
    readFileSync(
      path.resolve(__dirname, "../src/transfers/runtime.ts"),
      "utf8",
    ),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
    },
  ).outputText;
  new Function("require", "module", "exports", source)(
    (id: string) => {
      if (id === "@tarojs/taro")
        return {
          getFileInfo: async () => {
            if (info instanceof Error) throw info;
            return info;
          },
        };
      if (id === "../api")
        return {
          apiClient: {
            forgetWriteKeys: async (keys: string[]) => {
              forgotten.push(keys);
            },
          },
        };
      if (id === "../auth/view-access") return { viewAccess: views };
      if (id === "./pending-transfers") return { PendingTransfers };
      throw new Error(`Unexpected import ${id}`);
    },
    module,
    module.exports,
  );
  const runtime = module.exports as {
    pendingTransfers: PendingTransfers;
    verifyTransferFile(file: TransferFile): Promise<void>;
  };
  await runtime.verifyTransferFile(file);
  info = { digest: "changed", size: file.size };
  await assert.rejects(runtime.verifyTransferFile(file), /不能直接重放/);
  info = new Error("missing file");
  await assert.rejects(runtime.verifyTransferFile(file), /不会取消或删除/);
  const scope = runtime.pendingTransfers.scope();
  runtime.pendingTransfers.beginImport(scope, 4, file);
  views.invalidate("suspend");
  views.invalidate("offline");
  views.invalidate("revalidate");
  assert.ok(runtime.pendingTransfers.importFor(scope, 4));
  views.invalidate("permission");
  assert.equal(
    runtime.pendingTransfers.importFor(runtime.pendingTransfers.scope(), 4),
    undefined,
  );
  assert.equal(forgotten.length, 1);
  runtime.pendingTransfers.beginMedia(
    runtime.pendingTransfers.scope(),
    9,
    file,
  );
  views.invalidate("session");
  assert.equal(forgotten.length, 2);
});

test("unknown media upload outcome preserves the original file and key on recovery", async () => {
  let uploads = 0;
  const f = fixture(async (request) => {
    if (request.url.endsWith("/management")) return ok({ id: 9 });
    if (request.uploadFilePath) {
      if (++uploads === 1) throw new Error("lost upload response");
      return ok({ id: 22 });
    }
    if (request.url.endsWith("/media/22"))
      return ok({ id: 22, mime_type: "image/png" });
    if (request.url.endsWith("/media-links")) return ok({});
    throw new Error(`Unexpected request ${request.url}`);
  });
  const scope = f.transfers.scope();
  const original = f.transfers.beginMedia(scope, 9, file);
  await assert.rejects(f.transfers.runMedia(f.api, original, verify));
  assert.equal(original.mediaId, undefined);
  await f.transfers.runMedia(f.api, f.transfers.mediaFor(scope, 9)!, verify);
  const sent = f.calls.filter((request) => request.uploadFilePath);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], sent[1]);
  assert.equal(sent[0].headers["Idempotency-Key"], original.keys.upload);
});
