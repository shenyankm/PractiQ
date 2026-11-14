import { invoke as nativeInvoke } from "@tauri-apps/api/core";
import type { DesktopBridge } from "../desktop/bridge";

declare global { interface Window { practiq?: DesktopBridge } }

export function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (typeof window !== "undefined" && window.practiq) {
    if (command !== "request" && command !== "read_asset" && command !== "ai_request") return Promise.reject({ code: "OPERATION_FAILED", message: "This operation has not been migrated yet" });
    const request = command === "read_asset" ? { type: "asset", hash: args?.hash } : command === "ai_request" ? { type: "ai_grade", request: args?.request } : args?.request;
    return window.practiq.request(request, args?.locale as string | undefined).then(reply => {
      if (!reply.ok) throw reply.error;
      return reply.value as T;
    });
  }
  return nativeInvoke<T>(command, args);
}
