import { useEffect, useState } from "react";
import { Check, RefreshCw, Save } from "lucide-react";
import { ApiError, type Client } from "./api";
import type { ImportSettingsSnapshot } from "./contracts.generated";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";

const errorText = (error: unknown) => error instanceof ApiError && error.code === "IMPORT_SETTINGS_CONFLICT" ? "设置已在其他页面更新。请重新读取，再调整并保存。" : error instanceof ApiError ? error.message : "无法读取或保存设置，请手动重试。";

export function ImportSettingsPanel({ client }: { client: Client }) {
  const [snapshot, setSnapshot] = useState<ImportSettingsSnapshot | null>(null);
  const [draft, setDraft] = useState({ tencentConcurrency: "5", readRetryCount: "2", retryBaseSeconds: "1" });
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(null); setSaved(false);
    void client.importSettings(controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setSnapshot(value); setDraft({ tencentConcurrency: String(value.settings.tencentConcurrency), readRetryCount: String(value.settings.readRetryCount), retryBaseSeconds: String(value.settings.retryBaseSeconds) });
    }).catch(error => { if (!controller.signal.aborted) setError(errorText(error)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [client, revision]);
  const changed = !!snapshot && Object.keys(draft).some(key => Number(draft[key as keyof typeof draft]) !== snapshot.settings[key as keyof typeof snapshot.settings]);
  async function save() {
    if (!snapshot || saving || !changed) return;
    setSaving(true); setError(null); setSaved(false);
    try {
      const value = await client.saveImportSettings({ revision: snapshot.revision, settings: { tencentConcurrency: Number(draft.tencentConcurrency), readRetryCount: Number(draft.readRetryCount), retryBaseSeconds: Number(draft.retryBaseSeconds) } });
      if (client.active) { setSnapshot(value); setSaved(true); }
    } catch (error) { if (client.active) setError(errorText(error)); }
    finally { setSaving(false); }
  }
  return <section className="settings-panel" aria-labelledby="execution-settings-heading">
    <div className="section-heading"><div><h2 id="execution-settings-heading">识别与恢复</h2><p>整个服务共享此设置。</p></div><Button variant="outline" disabled={loading || saving} onClick={() => setRevision(value => value + 1)}><RefreshCw />重新读取设置</Button></div>
    {loading && <p role="status">正在读取导入设置…</p>}
    {error && <p className="error-banner" role="alert">{error}</p>}
    {snapshot && <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <fieldset disabled={loading || saving} className="settings-fields">
        {([
          ["tencentConcurrency", "腾讯识别并发上限", "1–5 个；调低不会中断正在处理的任务。", 1, 5, 1],
          ["readRetryCount", "读取失败重试次数", "0–5 次，0 表示不重试；仅限已知任务的查询与结果下载。", 0, 5, 1],
          ["retryBaseSeconds", "初始退避间隔（秒）", "0.5–10 秒；重试间隔逐次翻倍。", 0.5, 10, "any"],
        ] as const).map(([key, label, help, min, max, step]) => <div className="setting-row" key={key}><div><label htmlFor={key}><strong>{label}</strong></label><p id={`${key}-help`}>{help}</p></div><Input id={key} type="number" min={min} max={max} step={step} required aria-describedby={`${key}-help`} value={draft[key]} onChange={event => { setDraft(previous => ({ ...previous, [key]: event.target.value })); setSaved(false); }} /></div>)}
      </fieldset>
      <p className="settings-safety">付费提交不会自动重试。结果未知时，先核对腾讯云任务。</p>
      <div className="settings-save"><Button type="submit" disabled={loading || saving || !changed}><Save />{saving ? "正在保存…" : "保存设置"}</Button>{saved && <span role="status"><Check />设置已保存</span>}</div>
    </form>}
    <section className="connection-info"><h2>服务连接</h2><p>访问令牌仅保留在当前页面，刷新后需重新连接。</p></section>
  </section>;
}
