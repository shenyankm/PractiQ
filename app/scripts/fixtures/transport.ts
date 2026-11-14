import { fixtureScenario } from "./scenario";

export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const scenario = fixtureScenario();
  if (scenario) {
    const { demoInvoke } = await import("./preview-data");
    return await demoInvoke(command, args || {}, scenario) as T;
  }
  // The query bypasses the browser harness route for tests with explicit IPC mocks.
  const nativePath = "../../src/transport.ts?browser-native";
  const { invoke } = await import(/* @vite-ignore */ nativePath) as typeof import("../../src/transport");
  return invoke<T>(command, args);
}
