import { useEffect, useState, type FormEvent, type MutableRefObject } from "react";
import Portal from "../../shared/cloud/App";
import { nativeBridge, setNativeBridge } from "../../shared/cloud/transport";
import { cloudRequest, nativeCloudBridge, type CloudStatus } from "./cloudTransport";
import { errorMessage } from "./api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "./i18n";
import "../../shared/cloud/style.css";

export function CloudPage({ settingsOnly = false, flushRef }: { settingsOnly?: boolean; flushRef?: MutableRefObject<() => Promise<void>> } = {}) {
  const [revision, setRevision] = useState(0);
  const [connected, setConnected] = useState("");
  const [loading, setLoading] = useState(true);
  const [origin, setOrigin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setLoading(true);
    setConnected("");
    void cloudRequest<CloudStatus>({ type: "status" }).then(value => {
      if (!active) return;
      if (!value.origin) throw new Error(t("导入服务暂不可用，请重试。离线练习仍可使用。"));
      const existing = nativeBridge();
      setNativeBridge(existing?.origin === value.origin ? existing : nativeCloudBridge(value.origin, value.generation));
      setConnected(value.origin);
      setOrigin(value.origin);
    }).catch(cause => { if (active) setError(errorMessage(cause, false)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; setNativeBridge(null); };
  }, [revision]);
  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !origin.trim() || origin.trim() === connected) return;
    if (!document.dispatchEvent(new Event("practiq-cloud-before-leave", { cancelable: true }))) return;
    setBusy(true);
    setError("");
    try {
      await flushRef?.current();
      await cloudRequest<CloudStatus>({ type: "configure", origin: origin.trim() });
      window.dispatchEvent(new Event("practiq-import-service-changed"));
      setRevision(current => current + 1);
    } catch (cause) {
      setError(errorMessage(cause, false));
    } finally {
      setBusy(false);
    }
  }
  if (loading) return <p role="status">{t("读取服务配置…")}</p>;
  if (!connected) return <div className="flex flex-col items-start gap-4 py-8">
    <p role="alert">{error || t("导入服务暂不可用，请重试。离线练习仍可使用。")}</p>
    <Button variant="outline" onClick={() => setRevision(value => value + 1)}>{t("重试")}</Button>
  </div>;
  return <div className={`cloud-portal embedded${settingsOnly ? " embedded-settings" : ""}`} key={`${connected}:${revision}`}>
    <Portal settingsOnly={settingsOnly} flushRef={flushRef} serviceSettings={settingsOnly && <section className="settings-panel" aria-labelledby="import-service-heading">
      <h2 id="import-service-heading">{t("AI 服务")}</h2>
      <p className="mb-4 text-sm text-muted-foreground">{t("文档导入和 AI 评分共用此后端，离线练习无需连接。")}</p>
      <form className="flex flex-wrap items-end gap-3" onSubmit={connect}>
        <label className="flex min-w-64 flex-1 flex-col gap-2">{t("AI 服务地址")}
          <Input type="url" required value={origin} onChange={event => setOrigin(event.target.value)} disabled={busy} />
        </label>
        <Button type="submit" disabled={busy || !origin.trim() || origin.trim() === connected}>{busy ? t("正在保存…") : t("保存服务地址")}</Button>
        <Button type="button" variant="ghost" disabled={busy || origin === connected} onClick={() => { setOrigin(connected); setError(""); }}>{t("取消")}</Button>
      </form>
      {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
    </section>} />
  </div>;
}
