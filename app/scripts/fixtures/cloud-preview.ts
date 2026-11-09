import type { AccountPlan, AccountSession, AccountUser, AccountUsage, ImportCapabilities } from "../../src/contracts.generated";
import type { PreviewScenario } from "./scenario";

let initialized = false, generation = 1;
let origin: string | null = "https://preview.practiq.invalid";
let user: AccountUser | null = null;
const session = (): AccountSession => ({ user, csrf: "", registrationEnabled: true });
const usage: AccountUsage = { limits: { freePages: 50, modelCalls: 1000, tencentCalls: 50, activeTasks: 1 }, usedPages: 0, remainingPages: 50, daily: [], calls: [] };
const plans: AccountPlan = {
  checkoutEnabled: false, environment: null, sandboxAmount: null,
  balance: { plan: "free", expiresAt: null, activeTasks: 1, freePages: 50, freeUsedPages: 0, freeRemainingPages: 50, remainingPages: 50, grants: [] },
  products: [
    { id: "free", name: "Free", amount: "0.00", pages: 50, durationDays: null, activeTasks: 1, priority: false },
    { id: "plus", name: "Plus", amount: "39.00", pages: 100, durationDays: 30, activeTasks: 2, priority: false },
    { id: "pro", name: "Pro", amount: "99.00", pages: 300, durationDays: 30, activeTasks: 3, priority: true },
    { id: "pages50", name: "50 页加量包", amount: "19.90", pages: 50, durationDays: 365, activeTasks: 1, priority: false },
  ],
};
const capabilities: ImportCapabilities = { sourceTypes: ["pdf", "text", "markdown", "image", "doc", "docx", "ppt", "pptx", "xls", "xlsx"], sourceMaxBytes: 25 * 1024 * 1024, officeAvailable: true, officeModes: [], modelConfigured: false, parserConfigured: false, parserInputMaxBytes: 8 * 1024 * 1024, modelBudget: { limit: 400, unitCalls: 4, contextUnitCalls: 8 } };

export function previewCloud(request: Record<string, unknown>, context: { origin: string; generation: number } | null, scenario: PreviewScenario) {
  if (!initialized) { initialized = true; if (scenario === "unconfigured") origin = null; }
  let value: unknown;
  if (request.type === "status") value = { origin, generation };
  else if (request.type === "configure") {
    const url = new URL(String(request.origin));
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw { code: "CLOUD_ORIGIN_INVALID" };
    origin = url.origin; user = null; ++generation; value = { origin, generation };
  } else {
    if (!origin || context?.origin !== origin || context.generation !== generation) throw { code: "CLOUD_ACCOUNT_CHANGED" };
    if (request.type === "forget_session") { user = null; ++generation; value = null; }
    else if (request.type === "fetch") {
      const path = String(request.path).split("?")[0], method = String(request.method || "GET");
      const body = (request.body || {}) as Record<string, unknown>;
      let status = 200, data: unknown;
      if (scenario === "error") { status = 503; data = { detail: { code: "演示服务暂不可用，请切换预览场景。" } }; }
      else if (path === "/api/auth/session" && method === "GET") data = session();
      else if (["/api/auth/login", "/api/auth/register"].includes(path) && method === "POST") {
        user = { id: "preview-account", email: String(body.email), name: "演示用户", role: "user", enabled: true };
        ++generation; data = session();
      } else if (["/api/auth/logout", "/api/auth/reset-password"].includes(path) && method === "POST") { user = null; ++generation; data = { ok: true }; }
      else if (!user) { status = 401; data = { detail: { code: "LOGIN_REQUIRED" } }; }
      else if (path === "/api/me/profile" && method === "PATCH") {
        if (!body.currentPassword) { status = 400; data = { detail: { code: "PASSWORD_REQUIRED" } }; }
        else { user = { ...user, name: typeof body.name === "string" ? body.name : user.name }; if (body.email || body.password) { user = null; ++generation; } data = { ok: true }; }
      } else if (method === "GET") {
        if (path === "/api/me/usage") data = usage;
        else if (path === "/api/me/plans") data = plans;
        else if (["/api/me/payments", "/api/me/tokens", "/api/me/sessions"].includes(path)) data = [];
        else if (path === "/api/import-capabilities") data = capabilities;
        else if (path === "/api/import-settings") data = { revision: "preview", settings: { tencentConcurrency: 1, readRetryCount: 2, retryBaseSeconds: 1, deduplicateQuestions: false, generateAnswers: false } };
        else if (["/api/document-tasks", "/api/me/banks"].includes(path)) data = { items: [], hasMore: false };
        else { status = 404; data = { detail: { code: "开发预览中没有此记录。" } }; }
      } else { status = 409; data = { detail: { code: "开发预览仅支持账户与资料演示，不会执行上传、评分或付款。" } }; }
      const bytes = new TextEncoder().encode(JSON.stringify(data));
      value = { status, mediaType: "application/json", bytes: btoa(String.fromCharCode(...bytes)) };
    } else throw { code: "CLOUD_PREVIEW_UNAVAILABLE" };
  }
  return { value, generation };
}
