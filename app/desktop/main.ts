import { app, BrowserWindow, dialog, ipcMain, protocol, safeStorage, session } from "electron";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DatabaseClient } from "./client.js";
import { AppError, invariant } from "./errors.js";
import { AiSettings } from "./ai-settings.js";
import { AiClient } from "./ai-client.js";
import { gradeAction } from "./grade-action.js";
import { SOURCE_FORMATS, sourceFileName } from "./ai-storage.js";
import { documentAction } from "./document-action.js";
import { writeNewFile, syncDirectory } from "./filesystem.js";

const base = dirname(fileURLToPath(import.meta.url));
const origin = "practiq://app";
const development = !app.isPackaged && process.env.PRACTIQ_DEV_URL === "http://127.0.0.1:1420";
const page = development ? "http://127.0.0.1:1420/" : `${origin}/`;
const trustedOrigin = development ? "http://127.0.0.1:1420" : origin;
const contentPolicy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'";
app.setName("PractiQ");
protocol.registerSchemesAsPrivileged([{ scheme: "practiq", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
let window: BrowserWindow | null = null;
let database: DatabaseClient | undefined;
let ai: AiClient | undefined;
let closeApproved = false;
let quitRequested = false;
let quitReady = false;
let shuttingDown: Promise<unknown> | undefined;

function trustedSender(event: Electron.IpcMainInvokeEvent): void {
  invariant(window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame &&
    event.senderFrame.origin === trustedOrigin, "OPERATION_FAILED", "Untrusted IPC sender");
}

function createWindow() {
  closeApproved = false;
  window = new BrowserWindow({
    title: "PractiQ", width: 1440, height: 960, minWidth: 1024, minHeight: 700,
    backgroundColor: "#090d15",
    webPreferences: { preload: join(base, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", event => event.preventDefault());
  window.webContents.on("will-redirect", event => event.preventDefault());
  window.on("close", event => {
    if (!closeApproved) { event.preventDefault(); window?.webContents.send("practiq:close-requested"); }
  });
  window.on("closed", () => { window = null; if (quitRequested) app.quit(); });
  void window.loadURL(page);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => { if (shuttingDown) return; if (window) { if (window.isMinimized()) window.restore(); window.focus(); } else createWindow(); });
  void app.whenReady().then(() => {
  const directory = !app.isPackaged && process.env.PRACTIQ_DATA_DIR
    ? resolve(process.env.PRACTIQ_DATA_DIR)
    : join(app.getPath("userData"), "electron-migration", "v4");
  database = new DatabaseClient(directory);
  const aiRuntime = () => { invariant(!shuttingDown, "AI_RUNTIME_UNAVAILABLE", "AI runtime is closing"); return ai ??= new AiClient(directory); };
  const aiSettings = new AiSettings(directory, {
    isAsyncEncryptionAvailable: () => process.platform === "darwin" ? safeStorage.isAsyncEncryptionAvailable() : Promise.resolve(false),
    encryptStringAsync: value => safeStorage.encryptStringAsync(value),
    decryptStringAsync: value => safeStorage.decryptStringAsync(value),
  });
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url.startsWith(`${origin}/`) ||
      development && (details.url.startsWith("http://127.0.0.1:1420/") || details.url.startsWith("ws://127.0.0.1:1420/"));
    callback({ cancel: !allowed });
  });
  const bundle = realpathSync(resolve(base, "../../../../dist"));
  protocol.handle("practiq", async request => {
    try {
      const url = new URL(request.url);
      if (url.host !== "app" || request.method !== "GET") return new Response(null, { status: 403 });
      const target = realpathSync(resolve(bundle, `.${decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)}`));
      const path = relative(bundle, target);
      if (path.startsWith("..") || isAbsolute(path)) return new Response(null, { status: 403 });
      const media: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".ico": "image/x-icon" };
      return new Response(new Uint8Array(await readFile(target)), { headers: {
        "Content-Type": media[extname(target)] ?? "application/octet-stream",
        "Content-Security-Policy": contentPolicy, "X-Content-Type-Options": "nosniff",
      } });
    } catch { return new Response(null, { status: 404 }); }
  });
  ipcMain.handle("practiq:request", async (event, request: unknown, locale?: unknown) => {
    try {
      trustedSender(event);
      invariant(locale === undefined || typeof locale === "string" && ["zh-CN", "zh-TW", "en"].includes(locale), "LOCAL_FILTER_INVALID", "Invalid language");
      invariant(Buffer.byteLength(JSON.stringify(request)) <= 16 * 1024 * 1024, "LOCAL_FILE_TOO_LARGE", "Request exceeds size limit");
      invariant(request && typeof request === "object" && !Array.isArray(request) && typeof (request as Record<string, unknown>).type === "string" && !(request as { type: string }).type.startsWith("_"), "LOCAL_FILTER_INVALID", "Invalid request type");
      const input = request as Record<string, unknown>;
      if (input.type === "document_request") {
        invariant(Object.keys(input).sort().join() === "request,type", "LOCAL_FILTER_INVALID", "Invalid document request fields");
        return { ok: true, value: await documentAction(input.request, aiSettings, () => aiRuntime(), database, async document => {
          const selected = await dialog.showOpenDialog(window!, { properties: ["openFile"], title: "修复原文 / Repair original source", filters: [{ name: document.fileName || "Original source", extensions: [document.fileName?.split(".").at(-1) || "*"] }] });
          return selected.canceled || selected.filePaths.length !== 1 ? null : selected.filePaths[0];
        }, async name => { const selected = await dialog.showSaveDialog(window!, { defaultPath: name, filters: [{ name: "ZIP", extensions: ["zip"] }] }); return selected.canceled || !selected.filePath ? null : selected.filePath; }) };
      }
      if (input.type === "save_document_bytes") {
        invariant(Object.keys(input).sort().join() === "bytes,name,type" && input.bytes instanceof ArrayBuffer && input.bytes.byteLength > 0 && input.bytes.byteLength <= 150 * 1024 * 1024, "LOCAL_FILTER_INVALID", "Invalid document download fields");
        sourceFileName(input.name);
        const selected = await dialog.showSaveDialog(window!, { defaultPath: input.name });
        if (selected.canceled || !selected.filePath) return { ok: true, value: false };
        writeNewFile(selected.filePath, Buffer.from(input.bytes)); syncDirectory(dirname(selected.filePath)); return { ok: true, value: true };
      }
      if (input.type === "ai_grade") {
        invariant(Object.keys(input).sort().join() === "request,type", "LOCAL_FILTER_INVALID", "Invalid grading fields");
        return { ok: true, value: await gradeAction(input.request, locale as string | undefined ?? "zh-CN", aiSettings, database!, () => aiRuntime()) };
      }
      if (input.type === "ai_settings") {
        invariant(Object.keys(input).length === 1, "LOCAL_FILTER_INVALID", "Invalid settings fields");
        return { ok: true, value: await aiSettings.view() };
      }
      if (input.type === "save_ai_settings") {
        invariant(Object.keys(input).sort().join() === "type,value", "LOCAL_FILTER_INVALID", "Invalid settings fields");
        return { ok: true, value: await aiSettings.save(input.value) };
      }
      if (input.type === "pick_document_sources") {
        invariant(Object.keys(input).length === 1, "LOCAL_FILTER_INVALID", "Invalid source-picker fields");
        const selected = await dialog.showOpenDialog(window!, { properties: ["openFile", "multiSelections"], filters: [{ name: "Documents", extensions: Object.keys(SOURCE_FORMATS) }] });
        if (selected.canceled || !selected.filePaths.length) return { ok: true, value: [] };
        const config = await aiSettings.view(), value = await (aiRuntime()).call({ type: "pick_sources", paths: selected.filePaths, revision: config.revision });
        invariant((await aiSettings.view()).revision === config.revision, "CLOUD_SERVICE_CHANGED", "AI settings changed; select the source again"); return { ok: true, value };
      }
      if (input.type === "upload_document_source") {
        invariant(Object.keys(input).sort().join() === "ticket,type" && typeof input.ticket === "string" && input.ticket.length <= 128, "LOCAL_FILTER_INVALID", "Invalid source-ticket fields");
        const config = await aiSettings.view(), value = await (aiRuntime()).call({ type: "upload_source", ticket: input.ticket, revision: config.revision });
        invariant((await aiSettings.view()).revision === config.revision, "CLOUD_SERVICE_CHANGED", "AI settings changed; select the source again"); return { ok: true, value };
      }
      if (input.type === "pick_import") {
        invariant(Object.keys(input).length === 1, "LOCAL_FILTER_INVALID", "Invalid file-picker fields");
        const selected = await dialog.showOpenDialog(window!, { properties: ["openFile"], filters: [{ name: "PractiQ", extensions: ["zip"] }] });
        if (selected.canceled || selected.filePaths.length !== 1) return { ok: true, value: null };
        return await database!.request({ type: "_preview_bank_zip", path: selected.filePaths[0] }, locale as string | undefined);
      }
      if (input.type === "export_bank") {
        invariant(Object.keys(input).sort().join() === "bank_id,type" && typeof input.bank_id === "string", "LOCAL_FILTER_INVALID", "Invalid export fields");
        const selected = await dialog.showSaveDialog(window!, { defaultPath: "PractiQ-bank.zip", filters: [{ name: "PractiQ", extensions: ["zip"] }] });
        if (selected.canceled || !selected.filePath) return { ok: true, value: null };
        return await database!.request({ type: "_export_bank", bank_id: input.bank_id, path: selected.filePath }, locale as string | undefined);
      }
      if (input.type === "backup") {
        invariant(Object.keys(input).length === 1, "LOCAL_FILTER_INVALID", "Invalid backup fields");
        const selected = await dialog.showSaveDialog(window!, { defaultPath: `PractiQ-backup-${new Date().toISOString().slice(0, 10)}.zip`, filters: [{ name: "PractiQ", extensions: ["zip"] }] });
        if (selected.canceled || !selected.filePath) return { ok: true, value: null };
        return await database!.request({ type: "_backup", path: selected.filePath }, locale as string | undefined);
      }
      if (input.type === "restore") {
        invariant(Object.keys(input).every(key => ["type", "recover_assets"].includes(key)) && (input.recover_assets === undefined || typeof input.recover_assets === "boolean"), "LOCAL_FILTER_INVALID", "Invalid restoration fields");
        const selected = await dialog.showOpenDialog(window!, { properties: ["openFile"], filters: [{ name: "PractiQ", extensions: ["zip"] }] });
        if (selected.canceled || selected.filePaths.length !== 1) return { ok: true, value: null };
        return await database!.request({ type: "_restore", path: selected.filePaths[0], recover_assets: input.recover_assets === true }, locale as string | undefined);
      }
      return await database!.request(request, locale as string | undefined);
    } catch (error) {
      return { ok: false, error: error instanceof AppError ? error.toJSON() : { code: "OPERATION_FAILED", message: "Local operation failed" } };
    }
  });
  ipcMain.handle("practiq:close", event => { trustedSender(event); closeApproved = true; window?.close(); });
  createWindow();
  app.on("activate", () => { if (!window && !shuttingDown) createWindow(); });
  // Window closure leaves background work alive; an explicit quit ends workers.
  app.on("before-quit", () => { quitRequested = true; });
  app.on("will-quit", event => {
    if (quitReady) return;
    event.preventDefault();
    shuttingDown ??= Promise.allSettled([ai?.close()]).then(() => Promise.allSettled([database?.close()])).then(() => { quitReady = true; app.quit(); });
  });
  });
}
