import type { ImportCapabilities } from "../../src/contracts.generated";
import type { PreviewScenario } from "./scenario";

let initialized = false, generation = 1;
let origin: string | null = "https://preview.practiq.invalid";
const capabilities: ImportCapabilities = { sourceTypes: ["pdf", "text", "markdown", "image", "doc", "docx", "ppt", "pptx", "xls", "xlsx"], sourceMaxBytes: 25 * 1024 * 1024, officeAvailable: true, officeModes: [], modelConfigured: false, parserConfigured: false, parserInputMaxBytes: 8 * 1024 * 1024, modelBudget: { limit: 400, unitCalls: 4, contextUnitCalls: 8 } };

export function previewCloud(request: Record<string, unknown>, context: { origin: string; generation: number } | null, scenario: PreviewScenario) {
  if (!initialized) { initialized = true; if (scenario === "unconfigured") origin = "http://127.0.0.1:8090"; }
  let value: unknown;
  if (request.type === "status") value = { origin, generation };
  else if (request.type === "configure") {
    const url = new URL(String(request.origin));
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw { code: "CLOUD_ORIGIN_INVALID" };
    origin = url.origin; ++generation; value = { origin, generation };
  } else {
    if (!origin || context?.origin !== origin || context.generation !== generation) throw { code: "CLOUD_SERVICE_CHANGED" };
    if (request.type === "fetch") {
      const path = String(request.path).split("?")[0], method = String(request.method || "GET");
      let status = 200, data: unknown;
      if (scenario === "error") { status = 503; data = { detail: { code: "演示服务暂不可用，请切换预览场景。" } }; }
      else if (method === "GET") {
        if (path === "/api/import-capabilities") data = capabilities;
        else if (path === "/api/import-settings") data = { revision: "preview", settings: { tencentConcurrency: 1, readRetryCount: 2, retryBaseSeconds: 1, deduplicateQuestions: false, generateAnswers: false } };
        else if (path === "/api/document-tasks") data = { items: [], hasMore: false };
        else { status = 404; data = { detail: { code: "开发预览中没有此记录。" } }; }
      } else { status = 409; data = { detail: { code: "开发预览不会执行上传或评分。" } }; }
      const bytes = new TextEncoder().encode(JSON.stringify(data));
      value = { status, mediaType: "application/json", bytes: btoa(String.fromCharCode(...bytes)) };
    } else throw { code: "CLOUD_PREVIEW_UNAVAILABLE" };
  }
  return { value, generation };
}
