import { useEffect, useState, type FormEvent, type MutableRefObject } from "react";
import type { DesktopAiSettingsView, DesktopAiSettingsSave } from "./contracts.generated";
import { desktopAiRequest } from "./desktop-cloud";
import { nativeBridge } from "../../shared/cloud/transport";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { errorMessage } from "./api";
import { t } from "./i18n";
import { DesktopTaskMaintenance } from "./DesktopTaskMaintenance";
import { Checkbox } from "@/components/ui/checkbox";
import { costDraft, costPreferences } from "../../shared/cost";
import { DesktopCostSettings } from "./DesktopCostSettings";
import { CostUsage } from "../../shared/cloud/CostUsage";

const credentials = [["modelApiKey", "模型 API Key"], ["tencentSecretId", "腾讯 Secret ID"], ["tencentSecretKey", "腾讯 Secret Key"]] as const;
type Secret = typeof credentials[number][0];
export function DesktopAiSettings({ initial, flushRef, onSaved, onReload }: { initial: DesktopAiSettingsView; flushRef?: MutableRefObject<() => Promise<void>>; onSaved: () => void; onReload: () => void }) {
  const [preferences, setPreferences] = useState(initial.preferences), [values, setValues] = useState({ modelApiKey: "", tencentSecretId: "", tencentSecretKey: "" }), [cleared, setCleared] = useState<Secret[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [cost, setCost] = useState(() => costDraft(initial.preferences.cost));
  const costChanged = JSON.stringify(cost) !== JSON.stringify(costDraft(initial.preferences.cost));
  const changed = costChanged || JSON.stringify(preferences) !== JSON.stringify(initial.preferences) || Object.values(values).some(Boolean) || cleared.length > 0;
  useEffect(() => {
    if (!changed && !busy) return;
    const guard = (event: Event) => { event.preventDefault(); setError(t("请先保存 AI 设置或取消修改。")); };
    document.addEventListener("practiq-cloud-before-leave", guard); document.addEventListener("practiq-before-window-close", guard);
    return () => { document.removeEventListener("practiq-cloud-before-leave", guard); document.removeEventListener("practiq-before-window-close", guard); };
  }, [changed, busy]);
  async function save(event: FormEvent) {
    event.preventDefault(); if (busy || !changed) return; setBusy(true); setError("");
    try {
      await flushRef?.current();
      const current = await desktopAiRequest<DesktopAiSettingsView>({ type: "ai_settings" });
      if (current.revision !== nativeBridge()?.revision) { setError(t("AI 设置已变化，请取消修改并重新读取设置后再保存。")); return; }
      const secrets = Object.fromEntries(credentials.filter(([key]) => values[key] || cleared.includes(key)).map(([key]) => [key, cleared.includes(key) ? "" : values[key]]));
      const value: DesktopAiSettingsSave = { revision: current.revision, preferences: { ...preferences, import: current.preferences.import, ...(costChanged || preferences.cost ? { cost: costPreferences(cost) } : {}) }, secrets };
      await desktopAiRequest<DesktopAiSettingsView>({ type: "save_ai_settings", value });
      setValues({ modelApiKey: "", tencentSecretId: "", tencentSecretKey: "" }); setCleared([]); onSaved();
    } catch (cause) { setError(errorMessage(cause, false)); } finally { setBusy(false); }
  }
  function cancel() { setPreferences(initial.preferences); setCost(costDraft(initial.preferences.cost)); setValues({ modelApiKey: "", tencentSecretId: "", tencentSecretKey: "" }); setCleared([]); setError(""); }
  async function reload() {
    if (busy) return; setBusy(true); setError("");
    try { await flushRef?.current(); onReload(); }
    catch (cause) { setError(errorMessage(cause, false)); }
    finally { setBusy(false); }
  }
  return <><section className="settings-panel desktop-ai-settings" aria-labelledby="desktop-ai-heading">
    <div className="section-heading"><h2 id="desktop-ai-heading">{t("AI 模型与识别")}</h2><Button variant="outline" disabled={busy} onClick={() => void reload()}>{changed ? t("放弃修改并重新读取") : t("重新读取 AI 设置")}</Button></div>
    <p className="mb-4 text-sm text-muted-foreground">{t("文档导入和主观评分共用此配置。凭据由系统加密保存在本机，不包含在学习备份中。")}</p>
    <form onSubmit={event => void save(event)} autoComplete="off">
      <fieldset disabled={busy} className="settings-fields">
        <div className="setting-row"><label htmlFor="desktop-ai-provider">{t("模型服务商")}</label><NativeSelect id="desktop-ai-provider" value={preferences.model.provider} onValueChange={value => setPreferences(previous => ({ ...previous, model: { ...previous.model, provider: value as typeof previous.model.provider } }))}>
          <NativeSelectOption value="openai">OpenAI {t("兼容接口")}</NativeSelectOption><NativeSelectOption value="dashscope">DashScope</NativeSelectOption><NativeSelectOption value="deepseek">DeepSeek</NativeSelectOption><NativeSelectOption value="moonshot">Moonshot</NativeSelectOption>
        </NativeSelect></div>
        <div className="setting-row"><label htmlFor="desktop-ai-endpoint">{t("模型 API 地址")}</label><Input id="desktop-ai-endpoint" type="url" maxLength={2048} value={preferences.model.baseUrl} onChange={event => setPreferences(previous => ({ ...previous, model: { ...previous.model, baseUrl: event.target.value } }))} /></div>
        <div className="setting-row"><label htmlFor="desktop-ai-model">{t("模型 ID")}</label><Input id="desktop-ai-model" maxLength={255} value={preferences.model.modelId} onChange={event => setPreferences(previous => ({ ...previous, model: { ...previous.model, modelId: event.target.value } }))} /></div>
        {credentials.map(([key, label]) => <div className="setting-row" key={key}><label htmlFor={`desktop-ai-${key}`}>{t(label)}<span className="block text-sm text-muted-foreground">{cleared.includes(key) ? t("保存后清除") : initial.configured[key] ? t("已保存；留空保留") : t("尚未配置")}</span></label><div className="credential-controls"><Input id={`desktop-ai-${key}`} type="password" maxLength={8192} autoComplete="new-password" spellCheck={false} value={values[key]} onChange={event => { setValues(previous => ({ ...previous, [key]: event.target.value })); setCleared(previous => previous.filter(value => value !== key)); }} /><Button type="button" variant="outline" disabled={!initial.configured[key]} onClick={() => { setValues(previous => ({ ...previous, [key]: "" })); setCleared(previous => previous.includes(key) ? previous.filter(value => value !== key) : [...previous, key]); }}>{cleared.includes(key) ? t("撤销清除") : t("清除凭据")}</Button></div></div>)}
        {([["maxOutputTokens", "单次最大输出 tokens", 1, 131072], ["timeoutSeconds", "模型请求超时（秒）", 1, 600]] as const).map(([key, label, min, max]) => <div className="setting-row" key={key}><label htmlFor={`desktop-ai-${key}`}>{t(label)}</label><Input id={`desktop-ai-${key}`} type="number" required min={min} max={max} step={1} value={preferences.model[key]} onChange={event => setPreferences(previous => ({ ...previous, model: { ...previous.model, [key]: Number(event.target.value) } }))} /></div>)}
        <div className="setting-row"><label htmlFor="desktop-ai-budget">{t("单任务模型调用上限")}</label><Input id="desktop-ai-budget" type="number" required min={1} max={10000} step={1} value={preferences.maxCalls} onChange={event => setPreferences(previous => ({ ...previous, maxCalls: Number(event.target.value) }))} /></div>
        <div className="setting-row"><label htmlFor="desktop-ai-run-timeout">{t("单轮任务超时（秒）")}</label><Input id="desktop-ai-run-timeout" type="number" required min={0.001} step="any" value={preferences.runTimeoutSeconds ?? 1800} onChange={event => setPreferences(previous => ({ ...previous, runTimeoutSeconds: Number(event.target.value) }))} /></div>
        <details className="py-4"><summary>{t("私有 COS 暂存（高级，可选）")}</summary>
          <p className="my-3 text-sm text-muted-foreground">{t("启用后，每个来源单元均先上传至私有 COS，再提交腾讯识别，不会自动切回 Base64。结果验证完成后删除暂存对象；本地原文和结果保留。COS 可能产生额外费用。")}</p>
          <label className="flex items-center gap-2 py-3"><Checkbox checked={preferences.tencentCos.enabled} onCheckedChange={checked => setPreferences(previous => ({ ...previous, tencentCos: { ...previous.tencentCos, enabled: checked === true } }))} />{t("启用私有 COS 暂存")}</label>
          <div className="setting-row"><label htmlFor="desktop-ai-cos-bucket">{t("COS 存储桶（含 APPID）")}</label><Input id="desktop-ai-cos-bucket" disabled={!preferences.tencentCos.enabled} required={preferences.tencentCos.enabled} maxLength={84} placeholder={t("例如：bucket-1250000000")} value={preferences.tencentCos.bucket} onChange={event => setPreferences(previous => ({ ...previous, tencentCos: { ...previous.tencentCos, bucket: event.target.value } }))} /></div>
          <div className="setting-row"><label htmlFor="desktop-ai-cos-region">{t("COS 地域")}</label><Input id="desktop-ai-cos-region" disabled={!preferences.tencentCos.enabled} required={preferences.tencentCos.enabled} maxLength={63} placeholder={t("例如：ap-guangzhou")} value={preferences.tencentCos.region} onChange={event => setPreferences(previous => ({ ...previous, tencentCos: { ...previous.tencentCos, region: event.target.value } }))} /></div>
        </details>
        <DesktopCostSettings value={cost} onChange={setCost} />
      </fieldset>
      <div className="mt-4 flex gap-3"><Button type="submit" disabled={busy || !changed}>{busy ? t("正在保存…") : t("保存 AI 设置")}</Button><Button type="button" variant="ghost" disabled={busy || !changed} onClick={cancel}>{t("取消")}</Button></div>
      {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
    </form>
  </section><CostUsage disabled={busy || changed} /><DesktopTaskMaintenance disabled={busy || changed} /></>;
}
