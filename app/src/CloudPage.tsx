import { useEffect, useRef, useState } from "react";
import Portal from "../../shared/cloud/AccountPortal";
import { nativeBridge, setNativeBridge } from "../../shared/cloud/transport";
import { cloudRequest, nativeCloudBridge, type CloudStatus } from "./cloudTransport";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { t } from "./i18n";
import { previewMode } from "./preview-mode";
import "../../shared/cloud/style.css";

export function CloudPage({ initialPage = "workspace" }: { initialPage?: "workspace" | "account" } = {}) {
  const live = useRef(false);
  const [revision, setRevision] = useState(0);
  const [origin, setOrigin] = useState(""), [connected, setConnected] = useState("");
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => {
    let active = true; live.current = true;
    void cloudRequest<CloudStatus>({ type: "status" }).then(value => { if (active && value.origin) { setOrigin(value.origin); const existing = nativeBridge(); setNativeBridge(existing?.origin === value.origin ? existing : nativeCloudBridge(value.origin, value.generation)); setConnected(value.origin); } }).catch(e => { if (active) setError(e.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; live.current = false; setNativeBridge(null); };
  }, []);
  return <div className="flex min-w-0 flex-col gap-5">
    {previewMode() && <p role="status" className="text-sm text-muted-foreground">{t("开发预览：仅演示账户与资料，所有更改仅保存在内存中。请勿输入真实密码。")}</p>}
    {!loading && !connected && <Card><CardHeader><CardTitle>{t("登录与注册")}</CardTitle><CardDescription>{t("先连接云端服务，即可登录或注册账户。离线练习始终可用。")}</CardDescription></CardHeader></Card>}
    <Card><details open={!connected || !!error}><summary className="flex cursor-pointer flex-wrap items-center gap-3 px-6 py-4 font-medium">{t("云端连接设置")}{connected && <span className="text-sm font-normal text-muted-foreground">{connected}</span>}</summary><CardContent className="flex flex-col gap-3">
      <p>{t("文档识别、解析和模型调用均在云端进行。离线练习和题库导入无需登录。")}</p>
      <form className="flex flex-wrap items-end gap-3" onSubmit={event => { event.preventDefault(); if (busy || !document.dispatchEvent(new Event("practiq-cloud-before-leave", {cancelable:true}))) return; setBusy(true); setError(""); void cloudRequest<CloudStatus>({ type: "configure", origin }).then(value => { if (!live.current || !value.origin) return; setRevision(v => v + 1); setNativeBridge(nativeCloudBridge(value.origin, value.generation)); setConnected(value.origin); setOrigin(value.origin); window.dispatchEvent(new Event("practiq-cloud-account-changed")); }).catch(e => setError(e.message)).finally(() => setBusy(false)); }}>
        <label className="flex min-w-64 flex-1 flex-col gap-2">{t("云端服务地址")}<Input type="url" required placeholder={t("例如 https://service.example.com")} value={origin} onChange={e => setOrigin(e.target.value)} disabled={busy || loading} /></label>
        <Button type="submit" variant="outline" disabled={busy || loading}>{busy ? t("正在连接…") : t("连接云端服务")}</Button>
      </form>
      {connected && <Button variant="ghost" disabled={busy} onClick={() => { if (!document.dispatchEvent(new Event("practiq-cloud-before-leave", {cancelable:true}))) return; setBusy(true); void nativeBridge()!.forgetSession().then(() => { if (live.current) { setRevision(v => v + 1); window.dispatchEvent(new Event("practiq-cloud-account-changed")); } }).catch(e => setError(e.message)).finally(() => { if (live.current) setBusy(false); }); }}>{t("清除本机登录状态")}</Button>}
      {error && <p role="alert">{error}</p>}
      {loading && <p role="status">{t("正在读取连接配置…")}</p>}
    </CardContent></details></Card>
    {connected && <div className="cloud-portal embedded" key={`${connected}:${revision}`}><Portal embedded initialPage={initialPage} /></div>}
  </div>;
}
