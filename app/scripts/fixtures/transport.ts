import { invoke as nativeInvoke } from "@tauri-apps/api/core";
import { fixtureScenario } from "./scenario";

export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const scenario = fixtureScenario();
  if (scenario) {
    const { demoInvoke } = await import("./preview-data");
    return await demoInvoke(command, args || {}, scenario) as T;
  }
  return nativeInvoke<T>(command, args);
}
