import { useEffect, useRef, useState } from "react";
import Portal from "../../shared/cloud/AccountPortal";
import { nativeBridge, setNativeBridge } from "../../shared/cloud/transport";
import { cloudRequest, nativeCloudBridge } from "./cloudTransport";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { t } from "./i18n";
import "../../shared/cloud/style.css";

type CloudStatus = { origin: string | null; generation: number };

export function CloudPage() {
  const live = useRef(false);
  const [revision, setRevision] = useState(0);
  const [origin, setOrigin] = useState(""), [connected, setConnected] = useState("");
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => {
    let active = true; live.current = true;
    void cloudRequest<CloudStatus>({ type: "status" }).then(value => { if (active && value.origin) { setOrigin(value.origin); setNativeBridge(nativeCloudBridge(value.origin, value.generation)); setConnected(value.origin); } }).catch(e => { if (active) setError(e.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; live.current = false; setNativeBridge(null); };
  }, []);
  return <div className="flex min-w-0 flex-col gap-5">
    <Card><details open={!connected || !!error}><summary className="flex cursor-pointer flex-wrap items-center gap-3 px-6 py-4 font-medium">{t("云端连接设置")}{connected && <span className="text-sm font-normal text-muted-foreground">{connected}</span>}</summary><CardContent className="flex flex-col gap-3">
      <p>{t("文档识别、解析和模型调用均在云端进行。离线练习和题库导入无需登录。")}</p>
      <form className="flex flex-wrap items-end gap-3" onSubmit={event => { event.preventDefault(); if (busy || !document.dispatchEvent(new Event("practiq-cloud-before-leave", {cancelable:true}))) return; setBusy(true); setError(""); void cloudRequest<CloudStatus>({ type: "configure", origin }).then(value => { if (!live.current || !value.origin) return; setRevision(v => v + 1); setNativeBridge(nativeCloudBridge(value.origin, value.generation)); setConnected(value.origin); setOrigin(value.origin); }).catch(e => setError(e.message)).finally(() => setBusy(false)); }}>
        <label className="flex min-w-64 flex-1 flex-col gap-2">{t("云端服务地址")}<Input type="url" required placeholder={t("例如 https://service.example.com")} value={origin} onChange={e => setOrigin(e.target.value)} disabled={busy || loading} /></label>
        <Button type="submit" variant="outline" disabled={busy || loading}>{busy ? t("正在连接…") : t("连接云端服务")}</Button>
      </form>
      {connected && <Button variant="ghost" disabled={busy} onClick={() => { if (!document.dispatchEvent(new Event("practiq-cloud-before-leave", {cancelable:true}))) return; setBusy(true); void nativeBridge()!.forgetSession().then(() => { if (live.current) setRevision(v => v + 1); }).catch(e => setError(e.message)).finally(() => { if (live.current) setBusy(false); }); }}>{t("清除本机登录状态")}</Button>}
      {error && <p role="alert">{error}</p>}
      {loading && <p role="status">{t("正在读取连接配置…")}</p>}
    </CardContent></details></Card>
    {connected && <div className="cloud-portal embedded" key={`${connected}:${revision}`}><Portal embedded /></div>}
  </div>;
}
