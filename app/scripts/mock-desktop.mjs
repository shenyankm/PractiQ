import { installPreviewAi } from "./fixtures/desktop-ai.ts";

export async function mockDesktop(page) {
  await page.addInitScript(installPreviewAi);
  await page.addInitScript(() => {
    window.practiq = {
      async request(request, locale) {
        try {
          const command = request.type === "asset" ? "read_asset" : request.type === "ai_grade" ? "ai_request" : "request";
          const args = request.type === "asset" ? { hash: request.hash } : { request: request.type === "ai_grade" ? request.request : request, locale };
          let value;
          try { value = await window.__practiqNativeMock.invoke(command, args); }
          catch (error) {
            if (!(error instanceof Error) || !/Unexpected|未实现|未知/.test(error.message) || !["ai_settings", "save_ai_settings", "document_request"].includes(request.type)) throw error;
            value = window.practiqAiFixture(request);
          }
          if (value == null && ["ai_settings", "document_request"].includes(request.type)) value = window.practiqAiFixture(request);
          return { ok: true, value };
        } catch (error) { return { ok: false, error }; }
      },
      onCloseRequested: () => () => {}, close: async () => {},
    };
  });
}
