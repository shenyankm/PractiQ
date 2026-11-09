import { useEffect, useState } from "react";
import Portal from "../../shared/cloud/AccountPortal";
import { nativeBridge, setNativeBridge } from "../../shared/cloud/transport";
import { cloudRequest, nativeCloudBridge, type CloudStatus } from "./cloudTransport";
import { Button } from "@/components/ui/button";
import { t } from "./i18n";
import "../../shared/cloud/style.css";

export function CloudPage({ initialPage = "workspace" }: { initialPage?: "workspace" | "account" } = {}) {
  const [revision, setRevision] = useState(0);
  const [connected, setConnected] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setConnected("");
    void cloudRequest<CloudStatus>({ type: "status" }).then(value => {
      if (!active || !value.origin) return;
      const existing = nativeBridge();
      setNativeBridge(existing?.origin === value.origin ? existing : nativeCloudBridge(value.origin, value.generation));
      setConnected(value.origin);
    }).catch(() => { /* The account page shows a recoverable service state. */ })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; setNativeBridge(null); };
  }, [revision]);
  if (loading) return <p role="status">{t("读取账户状态…")}</p>;
  if (!connected) return <div className="flex flex-col items-start gap-4 py-8">
    <p role="status">{t("账户服务暂不可用，请稍后重试。离线练习仍可使用。")}</p>
    <Button variant="outline" onClick={() => setRevision(value => value + 1)}>{t("重试")}</Button>
  </div>;
  return <div className="cloud-portal embedded" key={`${connected}:${revision}`}><Portal embedded initialPage={initialPage} /></div>;
}
