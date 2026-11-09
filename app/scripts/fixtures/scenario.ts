// These scenarios are installed explicitly by browser tests, never by the App.
export const previewScenarios = { normal: "完整数据", empty: "空数据", many: "多页数据", slow: "慢加载", error: "请求失败", unconfigured: "未配置 AI 服务", missing: "资源缺失" } as const;
export type PreviewScenario = keyof typeof previewScenarios;
export function fixtureScenario(): PreviewScenario | null {
  const value = sessionStorage.getItem("practiq-test-scenario") || "normal";
  return value in previewScenarios ? value as PreviewScenario : null;
}
