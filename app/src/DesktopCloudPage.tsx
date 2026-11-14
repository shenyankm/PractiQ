import { useEffect, useState, type MutableRefObject } from "react";
import Portal from "../../shared/cloud/App";
import { nativeBridge, setNativeBridge } from "../../shared/cloud/transport";
import type { DesktopAiSettingsView } from "./contracts.generated";
import { desktopAiRequest, desktopCloudBridge } from "./desktop-cloud";
import { DesktopAiSettings } from "./DesktopAiSettings";
import { Button } from "@/components/ui/button";
import { errorMessage } from "./api";
import { t } from "./i18n";

export function DesktopCloudPage({ settingsOnly = false, flushRef }: { settingsOnly?: boolean; flushRef?: MutableRefObject<() => Promise<void>> }) {
  const [revision, setRevision] = useState(0), [loaded, setLoaded] = useState<{ revision: number; value: DesktopAiSettingsView } | null>(null), [error, setError] = useState("");
  useEffect(() => {
    let active = true, bridge: ReturnType<typeof desktopCloudBridge> | undefined;
    setLoaded(null); setError("");
    void desktopAiRequest<DesktopAiSettingsView>({ type: "ai_settings" }).then(value => {
      if (!active) return;
      bridge = desktopCloudBridge(value); setNativeBridge(bridge); setLoaded({ revision, value });
    }).catch(cause => { if (active) setError(errorMessage(cause, false)); });
    return () => { active = false; if (nativeBridge() === bridge) setNativeBridge(null); };
  }, [revision]);
  const settings = loaded?.revision === revision ? loaded.value : null;
  if (!settings) return error ? <div className="flex flex-col items-start gap-4 py-8"><p role="alert">{error}</p><Button variant="outline" onClick={() => setRevision(value => value + 1)}>{t("重试")}</Button></div> : <p role="status">{t("正在读取 AI 设置…")}</p>;
  return <div className={`cloud-portal embedded${settingsOnly ? " embedded-settings" : ""}`} key={revision}>
    <Portal settingsOnly={settingsOnly} flushRef={flushRef} serviceSettings={settingsOnly && <DesktopAiSettings initial={settings} flushRef={flushRef} onReload={() => setRevision(value => value + 1)} onSaved={() => { window.dispatchEvent(new Event("practiq-import-service-changed")); setRevision(value => value + 1); }} />} />
  </div>;
}
