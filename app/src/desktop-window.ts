export function isDesktop(): boolean { return Boolean(window.practiq); }
export function desktopWindow() {
  const bridge = window.practiq;
  if (!bridge) throw Object.assign(new Error("Open PractiQ in the desktop application"), { code: "DESKTOP_UNAVAILABLE" });
  return {
    onCloseRequested: async (listener: (event: { preventDefault(): void }) => void | Promise<void>) =>
      bridge.onCloseRequested(() => { void listener({ preventDefault() {} }); }),
    destroy: () => bridge.close(),
  };
}
