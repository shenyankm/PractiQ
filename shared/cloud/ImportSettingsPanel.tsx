import { t, useCloudLocale } from "./i18n";
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { createPortal } from "react-dom";
import { Check, LoaderCircle, RefreshCw, X } from "lucide-react";
import { ApiError, type Client } from "./api";
import type { ImportSettingsSnapshot } from "./contracts.generated";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Switch } from "./components/ui/switch";

const errorText = (error: unknown) => error instanceof ApiError && error.code === "IMPORT_SETTINGS_CONFLICT" ? t("设置已在其他页面更新。请重新读取后再调整。") : error instanceof ApiError ? error.message : t("无法读取或保存设置，请手动重试。");

export function ImportSettingsPanel({ client, onSettingsChange, onPendingChange, flushRef }: { client: Client; onSettingsChange?: (value: ImportSettingsSnapshot) => void; onPendingChange?: (pending: boolean) => void; flushRef?: MutableRefObject<() => Promise<void>> }) {
  useCloudLocale();
  const [snapshot, setSnapshot] = useState<ImportSettingsSnapshot | null>(null);
  const [draft, setDraft] = useState({ tencentConcurrency: "5", readRetryCount: "2", retryBaseSeconds: "1", deduplicateQuestions: false, generateAnswers: false });
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const editVersion = useRef(0);
  const currentSnapshot = useRef<ImportSettingsSnapshot | null>(null);
  const pending = useRef<{ version: number; request: Promise<void> } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(null); setSaved(false);
    void client.importSettings(controller.signal).then(value => {
      if (controller.signal.aborted) return;
      currentSnapshot.current = value;
      setSnapshot(value); setDraft({ tencentConcurrency: String(value.settings.tencentConcurrency), readRetryCount: String(value.settings.readRetryCount), retryBaseSeconds: String(value.settings.retryBaseSeconds), deduplicateQuestions: value.settings.deduplicateQuestions ?? false, generateAnswers: value.settings.generateAnswers ?? false });
      onSettingsChange?.(value);
    }).catch(error => { if (!controller.signal.aborted) setError(errorText(error)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [client, revision, onSettingsChange]);
  const numericKeys = ["tencentConcurrency", "readRetryCount", "retryBaseSeconds"] as const;
  const changed = !!snapshot && (numericKeys.some(key => draft[key].trim() === "" || Number(draft[key]) !== snapshot.settings[key])
    || draft.deduplicateQuestions !== (snapshot.settings.deduplicateQuestions ?? false)
    || draft.generateAnswers !== (snapshot.settings.generateAnswers ?? false));
  const valid = numericKeys.every(key => draft[key].trim() !== "")
    && Number.isInteger(Number(draft.tencentConcurrency)) && Number(draft.tencentConcurrency) >= 1 && Number(draft.tencentConcurrency) <= 5
    && Number.isInteger(Number(draft.readRetryCount)) && Number(draft.readRetryCount) >= 0 && Number(draft.readRetryCount) <= 5
    && Number.isFinite(Number(draft.retryBaseSeconds)) && Number(draft.retryBaseSeconds) >= 0.5 && Number(draft.retryBaseSeconds) <= 10;
  useEffect(() => { onPendingChange?.(loading || saving || changed || !!error); }, [loading, saving, changed, error, onPendingChange]);
  useEffect(() => {
    if (!saved || changed || saving) return;
    const timer = setTimeout(() => setSaved(false), 3000);
    return () => clearTimeout(timer);
  }, [saved, changed, saving]);
  const persist = useCallback(async () => {
    if (!snapshot || !changed) return;
    if (error) throw new ApiError(error, "IMPORT_SETTINGS_PENDING");
    if (!valid) throw new ApiError(t("数值无效，尚未保存"), "IMPORT_SETTINGS_INVALID");
    const version = editVersion.current;
    if (pending.current?.version === version) return pending.current.request;
    if (pending.current) await pending.current.request;
    if (version !== editVersion.current) throw new ApiError(t("正在自动保存…"), "IMPORT_SETTINGS_PENDING");
    const settings = {
      tencentConcurrency: Number(draft.tencentConcurrency), readRetryCount: Number(draft.readRetryCount), retryBaseSeconds: Number(draft.retryBaseSeconds),
      deduplicateQuestions: draft.deduplicateQuestions, generateAnswers: draft.generateAnswers,
    };
    const base = currentSnapshot.current ?? snapshot;
    if (Object.entries(settings).every(([key, value]) => base.settings[key as keyof typeof settings] === value)) return;
    setSaving(true); setSaved(false);
    const request = client.saveImportSettings({ revision: base.revision, settings }).then(value => {
      if (client.active) { currentSnapshot.current = value; setSnapshot(value); setSaved(true); onSettingsChange?.(value); }
    }).catch(error => { if (client.active) setError(errorText(error)); throw error; })
      .finally(() => { pending.current = null; if (client.active) setSaving(false); });
    pending.current = { version, request };
    return request;
  }, [client, snapshot, changed, valid, draft, error, onSettingsChange]);
  useEffect(() => {
    if (!flushRef) return;
    const flush = async () => {
      const version = editVersion.current;
      await persist();
      if (version !== editVersion.current) throw new ApiError(t("正在自动保存…"), "IMPORT_SETTINGS_PENDING");
    };
    flushRef.current = flush;
    return () => { if (flushRef.current === flush) flushRef.current = async () => {}; };
  }, [flushRef, persist]);
  useEffect(() => {
    if (!snapshot || loading || saving || !changed || !valid || error) return;
    const timer = setTimeout(() => { void persist().catch(() => {}); }, 600);
    return () => clearTimeout(timer);
  }, [snapshot, loading, saving, changed, valid, error, persist]);
  return <section className="settings-panel" aria-labelledby="execution-settings-heading">
    <div className="section-heading"><div><h2 id="execution-settings-heading">{t("识别与恢复")}</h2></div><Button variant="outline" disabled={loading || saving} onClick={() => setRevision(value => value + 1)}><RefreshCw />{t("重新读取设置")}</Button></div>
    {loading && <p role="status">{t("正在读取导入设置…")}</p>}
    {error && <p className="error-banner" role="alert">{error}</p>}
    {snapshot && <form onSubmit={event => event.preventDefault()}>
      <fieldset disabled={loading} className="settings-fields">
        {([["deduplicateQuestions", t("自动去重")], ["generateAnswers", t("AI 生成答案与解析")]] as const).map(([key, label]) =>
          <div className="setting-row" key={key}><label htmlFor={key}><strong>{label}</strong></label><Switch id={key} checked={draft[key]} onCheckedChange={checked => { ++editVersion.current; setDraft(previous => ({ ...previous, [key]: checked })); setSaved(false); }} /></div>)}
        {([
          ["tencentConcurrency", t("腾讯识别并发上限"), 1, 5, 1],
          ["readRetryCount", t("读取失败重试次数"), 0, 5, 1],
          ["retryBaseSeconds", t("初始退避间隔（秒）"), 0.5, 10, "any"],
        ] as const).map(([key, label, min, max, step]) => <div className="setting-row" key={key}><label htmlFor={key}><strong>{label}</strong></label><Input id={key} type="number" min={min} max={max} step={step} required aria-invalid={draft[key] !== "" && (!Number.isFinite(Number(draft[key])) || Number(draft[key]) < min || Number(draft[key]) > max || step === 1 && !Number.isInteger(Number(draft[key]))) || undefined} value={draft[key]} onChange={event => { ++editVersion.current; setDraft(previous => ({ ...previous, [key]: event.target.value })); setSaved(false); }} /></div>)}
      </fieldset>
    </form>}
    {!error && (changed || saving || saved) && createPortal(<div className="settings-toast"><span role="status">{!valid ? t("数值无效，尚未保存") : changed || saving ? <><LoaderCircle className="loading-icon" />{t("正在自动保存…")}</> : <><Check />{t("设置已保存")}</>}</span>{saved && !changed && !saving && <Button variant="ghost" size="icon" aria-label={t("关闭保存提示")} onClick={() => setSaved(false)}><X /></Button>}</div>, document.querySelector(".cloud-portal") || document.body)}
  </section>;
}
