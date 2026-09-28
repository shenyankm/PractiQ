import { invoke as nativeInvoke } from "@tauri-apps/api/core";
import { previewMode } from "./preview-mode";

export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const scenario = previewMode();
  if (import.meta.env.DEV && scenario) {
    const { demoInvoke } = await import("./preview-data");
    return await demoInvoke(command, args || {}, scenario) as T;
  }
  return nativeInvoke<T>(command, args);
}
