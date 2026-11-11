import { useEffect, useState, type FormEvent } from "react";
import Portal from "../../shared/cloud/AccountPortal";
import { nativeBridge, setNativeBridge } from "../../shared/cloud/transport";
import { cloudRequest, nativeCloudBridge, type CloudStatus } from "./cloudTransport";
import { errorMessage } from "./api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { t } from "./i18n";
import "../../shared/cloud/style.css";

export function CloudPage({ initialPage = "workspace" }: { initialPage?: "workspace" | "account" | "plans" } = {}) {
  const [revision, setRevision] = useState(0);
  const [connected, setConnected] = useState("");
  const [unconfigured, setUnconfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [origin, setOrigin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setLoading(true);
    setConnected("");
    setUnconfigured(false);
    setEditing(false);
    void cloudRequest<CloudStatus>({ type: "status" }).then(value => {
      if (!active) return;
      if (!value.origin) { setUnconfigured(true); return; }
      const existing = nativeBridge();
      setNativeBridge(existing?.origin === value.origin ? existing : nativeCloudBridge(value.origin, value.generation));
      setConnected(value.origin);
    }).catch(() => { /* The account page shows a recoverable service state. */ })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; setNativeBridge(null); };
  }, [revision]);
  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !origin.trim()) return;
    setBusy(true);
    setError("");
    try {
      const value = await cloudRequest<CloudStatus>({ type: "configure", origin: origin.trim() });
      if (value.origin) {
        setOrigin(value.origin);
        setEditing(false);
        window.dispatchEvent(new Event("practiq-cloud-account-changed"));
        setRevision(current => current + 1);
      }
    } catch (cause) {
      setError(errorMessage(cause, false));
    } finally {
      setBusy(false);
    }
  }
  async function forgetLocalSession() {
    const bridge = nativeBridge();
    if (!bridge || busy) return;
    setBusy(true);
    setError("");
    try {
      await bridge.forgetSession();
      setLoading(true);
      window.dispatchEvent(new Event("practiq-cloud-account-changed"));
      setRevision(current => current + 1);
    } catch (cause) {
      setError(errorMessage(cause, false));
    } finally {
      setBusy(false);
    }
  }
  if (loading) return <p role="status">{t("读取账户状态…")}</p>;
  if (unconfigured || editing) return <Card className="mx-auto max-w-3xl">
    <CardHeader>
      <CardTitle><h2>{editing ? t("更改云端服务地址") : t("连接云端服务")}</h2></CardTitle>
      <CardDescription>{t("文档识别、解析和模型调用均在云端进行。离线练习和题库导入无需登录。")}</CardDescription>
    </CardHeader>
    <CardContent className="space-y-4">
      <form className="flex flex-wrap items-end gap-3" onSubmit={connect}>
        <label className="flex min-w-64 flex-1 flex-col gap-2">{t("云端服务地址")}
          <Input type="url" required placeholder={t("例如 https://service.example.com")} value={origin} onChange={event => setOrigin(event.target.value)} disabled={busy} />
        </label>
        <Button type="submit" disabled={busy || !origin.trim()}>{busy ? t("正在连接…") : t("连接云端服务")}</Button>
      </form>
      {error && <p role="alert" className="text-destructive">{error}</p>}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{t("连接后即可登录、注册或管理云端导入任务；地址保存在本机，可随时重新连接。")}</p>
        <div className="flex gap-2">
          {editing && <Button type="button" variant="ghost" disabled={busy} onClick={() => { setEditing(false); setError(""); }}>{t("取消")}</Button>}
          {!editing && <Button type="button" variant="ghost" disabled={busy} onClick={() => setRevision(value => value + 1)}>{t("重试")}</Button>}
        </div>
      </div>
    </CardContent>
  </Card>;
  if (!connected) return <div className="flex flex-col items-start gap-4 py-8">
    <p role="status">{t("账户服务暂不可用，请稍后重试。离线练习仍可使用。")}</p>
    <Button variant="outline" onClick={() => setRevision(value => value + 1)}>{t("重试")}</Button>
  </div>;
  return <div className="space-y-3">
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="cloud-portal embedded" key={`${connected}:${revision}`}>
      <Portal embedded initialPage={initialPage} onChangeService={() => { setError(""); setOrigin(connected); setEditing(true); }} onForgetSession={forgetLocalSession} />
    </div>
  </div>;
}
