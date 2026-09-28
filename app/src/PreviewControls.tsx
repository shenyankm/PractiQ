import { t, useI18n } from "./i18n";
import { previewMode, previewScenarios } from "./preview-mode";

export default function PreviewControls() {
  useI18n();
  const scenario = previewMode();
  return <details className="fixed bottom-3 right-3 z-[100] max-w-sm rounded-lg border bg-popover p-3 text-xs text-popover-foreground shadow-lg">
    <summary className="cursor-pointer font-medium">{scenario ? t("开发预览 · 示例数据") : t("开发预览 · 真实数据")}</summary>
    <div className="mt-3 space-y-3">
      <p>{t("示例操作仅保存在内存，不访问文件、密钥或模型。切换场景或重置将清除示例修改并回到首页。")}</p>
      <label className="flex items-center gap-2">{t("预览场景")}<select aria-label={t("预览场景")} className="rounded border bg-background p-1" value={scenario || "real"} onChange={event => { sessionStorage.setItem("practiq-preview", event.target.value); location.reload(); }}>
        {Object.entries(previewScenarios).map(([value,label]) => <option key={value} value={value}>{t(label)}</option>)}
        <option value="real">{t("真实本地数据")}</option>
      </select></label>
      <button className="rounded border px-2 py-1" onClick={() => location.reload()}>{t("重置预览")}</button>
    </div>
  </details>;
}
