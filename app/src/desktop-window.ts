import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export function isDesktop(): boolean { return Boolean(window.practiq) || isTauri(); }
export function desktopWindow() {
  const bridge = window.practiq;
  if (!bridge) return getCurrentWindow();
  return {
    onCloseRequested: async (listener: (event: { preventDefault(): void }) => void | Promise<void>) =>
      bridge.onCloseRequested(() => { void listener({ preventDefault() {} }); }),
    destroy: () => bridge.close(),
  };
}
