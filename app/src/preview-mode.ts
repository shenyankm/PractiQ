// Preview is opt-out in development and absent from production/test runs.
export const previewScenarios = { normal: "完整数据", empty: "空数据", many: "多页数据", slow: "慢加载", error: "请求失败", unconfigured: "未配置 AI 服务", missing: "资源缺失" } as const;
export type PreviewScenario = keyof typeof previewScenarios;
export function previewMode(): PreviewScenario | null {
  if (!import.meta.env.DEV || import.meta.env.MODE === "test") return null;
  const value = sessionStorage.getItem("practiq-preview") || "normal";
  return value in previewScenarios ? value as PreviewScenario : null;
}
