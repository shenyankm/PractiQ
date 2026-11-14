import type { DesktopAiSettingsSave } from "../../src/contracts.generated";

declare global { interface Window { practiqAiFixture?: (request: Record<string, unknown>) => unknown } }

// Self-contained so Playwright can install the same in-memory fixture before page scripts.
export function installPreviewAi() {
  let view = {
    revision: "11111111-1111-4111-8111-111111111111",
    preferences: {
      model: { provider: "openai", baseUrl: "https://api.openai.com/v1", modelId: "gpt-5-mini", maxOutputTokens: 8192, timeoutSeconds: 120 },
      import: { tencentConcurrency: 2, readRetryCount: 2, retryBaseSeconds: 1, deduplicateQuestions: false, generateAnswers: false },
      maxCalls: 400, runTimeoutSeconds: 1800, tencentCos: { enabled: false, bucket: "", region: "" },
    } as DesktopAiSettingsSave["preferences"],
    configured: { modelApiKey: false, tencentSecretId: false, tencentSecretKey: false },
  };
  window.practiqAiFixture = request => {
    if (request.type === "ai_settings") return structuredClone(view);
    if (request.type === "save_ai_settings") {
      const value = request.value as DesktopAiSettingsSave;
      if (value.revision !== view.revision) throw { code: "AI_SETTINGS_CHANGED" };
      view = { revision: crypto.randomUUID(), preferences: structuredClone(value.preferences), configured: { ...view.configured } };
      for (const [key, secret] of Object.entries(value.secrets ?? {})) view.configured[key as keyof typeof view.configured] = Boolean(secret);
      return structuredClone(view);
    }
    if (request.type === "document_request") {
      const action = request.request as Record<string, unknown>; let value: unknown;
      switch (action.type) {
        case "capabilities": value = { sourceTypes: ["pdf", "text", "markdown", "image", "doc", "docx", "ppt", "pptx", "xls", "xlsx"], sourceMaxBytes: 150 * 1024 * 1024, officeMaxBytes: 8 * 1024 * 1024, officeAvailable: true, officeModes: [], modelConfigured: false, parserConfigured: false, parserInputMaxBytes: 8 * 1024 * 1024, modelBudget: { limit: view.preferences.maxCalls, unitCalls: 4, contextUnitCalls: 8 } }; break;
        case "import_settings": value = { revision: view.revision, settings: view.preferences.import }; break;
        case "save_import_settings": view = { ...view, revision: crypto.randomUUID(), preferences: { ...view.preferences, import: (action.value as { settings: typeof view.preferences.import }).settings } }; value = { revision: view.revision, settings: view.preferences.import }; break;
        case "list": value = { items: [], hasMore: false, nextCursor: null }; break;
        case "maintenance_preview": value = { previewId: crypto.randomUUID(), expiresAt: new Date(Date.now() + 600000).toISOString(), candidates: [], hasMore: false, skipped: 0, canClean: true, pending: [] }; break;
        case "cost_report": value = { enabled: false, currency: "", utcDay: new Date().toISOString().slice(0, 10), day: null, task: null, taskLimitMicros: null, dailyLimitMicros: null, recent: [] }; break;
        default: throw new Error(`Preview does not execute AI action: ${action.type}`);
      }
      return { type: action.type, value };
    }
    throw new Error(`Preview does not execute native action: ${request.type}`);
  };
}
