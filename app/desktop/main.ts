import { app, BrowserWindow, crashReporter, dialog, ipcMain, Menu, protocol, safeStorage, screen, session } from "electron";
import { dirname, join, resolve } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DatabaseClient } from "./client.js";
import { AppError, invariant } from "./errors.js";
import { AiSettings } from "./ai-settings.js";
import { AiClient } from "./ai-client.js";
import { gradeAction } from "./grade-action.js";
import { SOURCE_FORMATS, sourceFileName } from "./ai-storage.js";
import { documentAction } from "./document-action.js";
import { writeNewFile, syncDirectory, readBounded } from "./filesystem.js";
import { ListeningWeb } from "./listening-web.js";
import { prepareListeningQr } from "./image-preparation.js";
import { validateContract } from "./contracts.js";
import { applicationMenuTemplate } from "./app-menu.js";
import { MainLog } from "./main-log.js";
import { bundleIndex, resolveBundleRequest, type BundleAsset } from "./protocol-assets.js";
import { withinRequestLimit } from "./request-size.js";
import { WINDOW_MINIMUM, parseWindowState, serializeWindowState, type WindowState } from "./window-state.js";

const base = dirname(fileURLToPath(import.meta.url));
const origin = "practiq://app";
const development = !app.isPackaged && process.env.PRACTIQ_DEV_URL === "http://127.0.0.1:1420";
const page = development ? "http://127.0.0.1:1420/" : `${origin}/`;
const trustedOrigin = development ? "http://127.0.0.1:1420" : origin;
/**
 * Startup milestones for field and CI diagnostics. Stages contain no paths, content or credentials,
 * and are printed only when an explicit trace flag is set.
 */
const trace = (stage: string) => { if (process.env.PRACTIQ_STARTUP_TRACE) console.error(`[practiq] ${stage}`); };
trace(`module electron ${process.versions.electron} node ${process.versions.node} packaged ${app.isPackaged}`);
app.on("will-finish-launching", () => trace("will-finish-launching"));
app.on("ready", () => trace("ready"));

const contentPolicy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'";
app.setName("PractiQ");
// Every renderer, including one created later, starts sandboxed and without Node integration.
app.enableSandbox();
// Local dumps only: diagnostics must never upload data, and a report is written for a user to share.
crashReporter.start({ uploadToServer: false });
protocol.registerSchemesAsPrivileged([{ scheme: "practiq", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
let window: BrowserWindow | null = null;
let database: DatabaseClient | undefined;
let ai: AiClient | undefined;
let closeApproved = false;
let quitRequested = false;
let quitReady = false;
let shuttingDown: Promise<unknown> | undefined;
let mainLog: MainLog | undefined;
const listeningWeb = new ListeningWeb(), listeningAbort = new AbortController();
const listeningJobs = new Set<Promise<unknown>>();
async function listeningWork<T>(work: Promise<T>): Promise<T> {
  listeningJobs.add(work); try { return await work; } finally { listeningJobs.delete(work); }
}

function log(scope: string, error: unknown): void {
  try { (mainLog ??= new MainLog(join(app.getPath("userData"), "logs", "main.log"))).record(scope, error); } catch { /* Diagnostics never block the operation they describe. */ }
}

// A main-process fault is recorded even when no window can show it; practice data stays on disk.
const fault = (scope: string, error: unknown) => { log(scope, error); console.error(`PractiQ ${scope}:`, error); };
process.on("uncaughtException", error => fault("uncaughtException", error));
process.on("unhandledRejection", reason => fault("unhandledRejection", reason));

const windowStateFile = () => join(app.getPath("userData"), "window-state.json");
function readWindowState(): WindowState | null {
  try { return parseWindowState(JSON.parse(readFileSync(windowStateFile(), "utf8")), screen.getAllDisplays().map(display => display.workArea)); }
  catch { return null; }
}
function saveWindowState(target: BrowserWindow): void {
  try {
    const file = windowStateFile();
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify(serializeWindowState(target.getNormalBounds(), target.isMaximized())), { mode: 0o600 });
  } catch (error) { log("window-state", error); }
}

/** A last-resort page for an unreadable local bundle: static text, no script and no IPC access. */
function failurePage(code: number): string {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>PractiQ</title></head><body style="font-family:-apple-system,system-ui;background:#090d15;color:#e5e7eb;padding:48px"><h1>界面加载失败</h1><p>无法读取本地界面资源（错误 ${code}）。请退出并重新启动 PractiQ；已保存的学习数据不会被修改。</p><p>The local interface could not be loaded (error ${code}). Quit and start PractiQ again; stored data is unchanged.</p></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function trustedSender(event: Electron.IpcMainInvokeEvent): void {
  invariant(window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame &&
    event.senderFrame.origin === trustedOrigin, "OPERATION_FAILED", "Untrusted IPC sender");
}

function createWindow() {
  closeApproved = false;
  const restored = readWindowState(), created: Electron.BrowserWindowConstructorOptions = {
    title: "PractiQ", width: restored?.width ?? 1440, height: restored?.height ?? 960,
    minWidth: WINDOW_MINIMUM.width, minHeight: WINDOW_MINIMUM.height,
    backgroundColor: "#090d15",
    webPreferences: {
      preload: join(base, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true,
      // A packaged window exposes neither developer tools nor a reload entry to its content.
      devTools: !app.isPackaged,
    },
  };
  // A saved position is reused only while the frame still fits inside a connected display.
  if (restored?.x !== undefined && restored.y !== undefined) { created.x = restored.x; created.y = restored.y; }
  trace("window-creating");
  const current = new BrowserWindow(created);
  trace("window-created");
  window = current;
  if (restored?.maximized) current.maximize();
  // The window is created visible: `ready-to-show` is not a reliable first-paint signal here,
  // and a hidden window would simply appear later than the background colour already prevents.
  const contents = current.webContents;
  let failedLoads = 0;
  contents.on("render-process-gone", (_event, details) => { if (details.reason !== "clean-exit") log("render-process-gone", `${details.reason} exitCode ${details.exitCode}`); });
  contents.on("unresponsive", () => log("unresponsive", "Renderer stopped responding"));
  contents.on("preload-error", (_event, preload, error) => log("preload-error", `${preload}: ${error.message}`));
  contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    // -3 is an intentional cancellation of an in-flight navigation, not a failed load.
    if (!isMainFrame || code === -3) return;
    log("did-fail-load", `${code} ${description} ${url}`);
    if (failedLoads++ === 0) { setTimeout(() => { if (!current.isDestroyed()) void current.loadURL(page); }, 500); return; }
    void contents.loadURL(failurePage(code));
  });
  current.on("close", event => {
    saveWindowState(current);
    // A crashed renderer cannot confirm the close, so it must never be able to block it.
    if (!closeApproved && !contents.isCrashed()) { event.preventDefault(); contents.send("practiq:close-requested"); }
  });
  current.on("closed", () => { window = null; if (quitRequested) app.quit(); });
  void current.loadURL(page).then(() => trace("window-loaded"), error => trace(`window-load-failed ${error?.code ?? "unknown"}`));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => { if (shuttingDown) return; if (window) { if (window.isMinimized()) window.restore(); window.focus(); } else createWindow(); });
  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", event => event.preventDefault());
    contents.on("will-redirect", event => event.preventDefault());
    contents.on("will-attach-webview", event => event.preventDefault());
  });
  void app.whenReady().then(() => {
  trace("whenReady");
  const directory = !app.isPackaged && process.env.PRACTIQ_DATA_DIR
    ? resolve(process.env.PRACTIQ_DATA_DIR)
    : join(app.getPath("userData"), "v4");
  database = new DatabaseClient(directory);
  trace("database-client");
  const aiRuntime = () => { invariant(!shuttingDown, "AI_RUNTIME_UNAVAILABLE", "AI runtime is closing"); return ai ??= new AiClient(directory); };
  const aiSettings = new AiSettings(directory, {
    isAsyncEncryptionAvailable: () => process.platform === "darwin" ? safeStorage.isAsyncEncryptionAvailable() : Promise.resolve(false),
    encryptStringAsync: value => safeStorage.encryptStringAsync(value),
    decryptStringAsync: value => safeStorage.decryptStringAsync(value),
  });
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  // PractiQ has no editable prose surface, so the native spell checker is never loaded.
  session.defaultSession.setSpellCheckerEnabled(false);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url.startsWith(`${origin}/`) ||
      development && (details.url.startsWith("http://127.0.0.1:1420/") || details.url.startsWith("ws://127.0.0.1:1420/"));
    callback({ cancel: !allowed });
  });
  trace("session");
  // The bundle may live inside app.asar, which the OS cannot canonicalize, so it is used as given.
  // An unreadable bundle must degrade to the failure page instead of preventing the window.
  let assets: Map<string, BundleAsset>;
  try { assets = bundleIndex(resolve(base, "../../../../dist")); }
  catch (error) { log("bundle-index", error); assets = new Map(); }
  trace("bundle-index");
  protocol.handle("practiq", async request => {
    if (request.method !== "GET") return new Response(null, { status: 403 });
    // The built bundle is indexed once, so a request selects a known file instead of a path.
    const asset = resolveBundleRequest(assets, request.url, origin);
    if (!asset) return new Response(null, { status: 404 });
    try {
      const bytes = await readFile(asset.file);
      return new Response(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), { headers: {
        "Content-Type": asset.mediaType, "Cache-Control": asset.cacheControl,
        "Content-Security-Policy": contentPolicy, "X-Content-Type-Options": "nosniff",
      } });
    } catch (error) { log("protocol-asset", error); return new Response(null, { status: 404 }); }
  });
  trace("protocol");
  ipcMain.handle("practiq:request", async (event, request: unknown, locale?: unknown) => {
    try {
      trustedSender(event);
      invariant(locale === undefined || typeof locale === "string" && ["zh-CN", "zh-TW", "en"].includes(locale), "LOCAL_FILTER_INVALID", "Invalid language");
      // Counted from the values themselves: a binary payload counts its real bytes without being serialized.
      invariant(withinRequestLimit(request), "LOCAL_FILE_TOO_LARGE", "Request exceeds size limit");
      invariant(request && typeof request === "object" && !Array.isArray(request) && typeof (request as Record<string, unknown>).type === "string" && !(request as { type: string }).type.startsWith("_"), "LOCAL_FILTER_INVALID", "Invalid request type");
      const input = request as Record<string, unknown>;
      if (input.type === "listening_links" || input.type === "load_listening_audio") {
        invariant(!shuttingDown, "LOCAL_AUDIO_DOWNLOAD_FAILED", "Listening resources are closing");
        validateContract("DesktopListeningRequest", input);
        return { ok: true, value: await listeningWork(listeningWeb.fetch(input.url, input.type === "listening_links" ? "links" : "audio")) };
      }
      if (input.type === "pick_audio_qr" || input.type === "decode_audio_qr") {
        invariant(!shuttingDown, "LOCAL_AUDIO_QR_INVALID", "Listening resources are closing");
        validateContract("DesktopListeningRequest", input);
        let bytes: Uint8Array;
        if (input.type === "pick_audio_qr") {
          const selected = await dialog.showOpenDialog(window!, { properties: ["openFile"], filters: [{ name: "QR image", extensions: ["png", "jpg", "jpeg"] }] });
          if (selected.canceled || selected.filePaths.length !== 1) return { ok: true, value: null };
          listeningAbort.signal.throwIfAborted();
          bytes = readBounded(selected.filePaths[0], 25 * 1024 * 1024);
        } else {
          const resource = await database!.request({ type: "asset", hash: input.hash }, locale as string | undefined);
          if (!resource.ok) return resource;
          invariant(resource.value instanceof ArrayBuffer, "LOCAL_AUDIO_QR_INVALID", "QR resource is unavailable"); bytes = new Uint8Array(resource.value);
        }
        return { ok: true, value: await listeningWork(prepareListeningQr(() => bytes, listeningAbort.signal)) };
      }
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
  trace("ipc");
  app.setAboutPanelOptions({ applicationName: "PractiQ", applicationVersion: app.getVersion(), version: `Electron ${process.versions.electron}`, copyright: "Open source single-person practice application" });
  // A packaged app keeps only the roles macOS needs for clipboard and window shortcuts.
  Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenuTemplate(app.isPackaged)));
  trace("menu");
  createWindow();
  trace("window");
  app.on("activate", () => {
    if (shuttingDown) return;
    // The dock icon is the only affordance left when a crashed renderer cannot paint.
    if (!window) { createWindow(); return; }
    if (window.webContents.isCrashed()) { log("renderer-recovery", "reloading a crashed renderer after activation"); window.webContents.reload(); }
  });
  // Window closure leaves background work alive; an explicit quit ends workers.
  app.on("window-all-closed", () => {});
  app.on("before-quit", () => { quitRequested = true; });
  app.on("will-quit", event => {
    if (quitReady) return;
    event.preventDefault();
    listeningWeb.close(); listeningAbort.abort();
    shuttingDown ??= Promise.allSettled([ai?.close(), ...listeningJobs]).then(() => Promise.allSettled([database?.close()])).then(() => { quitReady = true; app.quit(); });
  });
  // A startup fault must never leave a windowless process behind: record it, then exit non-zero.
  }).catch(error => { fault("startup", error); app.exit(1); });
}
