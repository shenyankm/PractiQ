import { invoke as nativeInvoke } from "@tauri-apps/api/core";

export function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return nativeInvoke<T>(command, args);
}
