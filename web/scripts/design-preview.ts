import type { Plugin } from "vite";
import { capabilities, preview, summary, task, taskId } from "../src/test-fixtures.ts";

// Preview API never forwards requests to the service, including unknown routes.
export function designPreview(): Plugin {
  return {
    name: "practiq-design-preview",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith("/api")) { next(); return; }
        const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.setHeader("Cache-Control", "no-store");
        let body: unknown;
        if (request.headers.authorization !== "Bearer preview-only") {
          response.statusCode = 401;
          body = { detail: { code: "INVALID_TOKEN" } };
        } else if (request.method !== "GET") {
          response.statusCode = 409;
          body = { detail: "设计预览使用模拟数据，此操作不会提交到服务。" };
        } else if (path === "/api/import-capabilities") body = capabilities;
        else if (path === "/api/document-tasks") body = { items: [summary], hasMore: false };
        else if (path === `/api/document-tasks/${taskId}`) body = task;
        else if (path === `/api/document-tasks/${taskId}/preview`) body = preview;
        else {
          response.statusCode = 404;
          body = { detail: "设计预览没有此资源，不会转发到真实服务。" };
        }
        response.end(JSON.stringify(body));
      });
    },
  };
}
