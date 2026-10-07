import { message, t, useI18n } from "./i18n";
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { toast } from "./notifications";
import { PlugZap, LoaderCircle, ChevronRight } from "lucide-react";
import {
  api,
  errorMessage,
  missingServiceSettings,
  type ServiceConfig,
  type SettingsResult,
} from "./api";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
export function ConnectionSettingsPanel({
  busy,
  run,
  onConfigure,
  flushRef,
}: {
  busy: boolean;
  run: (job: () => Promise<void>) => void;
  onConfigure?: () => void;
  flushRef?: MutableRefObject<() => Promise<void>>;
}) {
  useI18n();
  const [saved, setSaved] = useState<SettingsResult | null>(null);
  const [config, setConfig] = useState<ServiceConfig>({
    service_url: null,
  });
  const [serviceToken, setServiceToken] = useState("");
  const [dirty, setDirty] = useState(false);
  const [operation, setOperation] = useState<"test" | "save" | "clear" | null>(null);
  const locked = useRef(false);
  const revision = useRef(0);
  const pending = useRef<{ version: number; request: Promise<SettingsResult> } | null>(null);
  useEffect(() => () => { ++revision.current; }, []);
  function invalidate() { ++revision.current; setDirty(true); setSaveError(null); }
  const [saveError, setSaveError] = useState<unknown>(null);
  const [error, setError] = useState<unknown>(null);
  const [waiting, setWaiting] = useState(false);
  const [reading, setReading] = useState(true);
  const [testResult, setTestResult] = useState<{ error?: unknown } | null>(null);
  const load = () => {
    let active = true;
    setWaiting(false);
    setReading(true);
    const timer = window.setTimeout(() => { if (active) setWaiting(true); }, 8000);
    void api({ type: "settings" })
      .then((result) => {
        if (active) {
          setSaved(result);
          setConfig(result.config);
          setError(null);
        }
      })
      .catch((e) => {
        if (active) setError(e);
      }).finally(() => { window.clearTimeout(timer); if (active) { setWaiting(false); setReading(false); } });
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  };
  useEffect(load, []);
  const configured =
    saved && saved.config.service_url === config.service_url ? saved.hasServiceToken : null;
  const missing = missingServiceSettings({ config, hasServiceToken: serviceToken.trim() ? true : configured });
  function field(name: keyof ServiceConfig, value: string) {
    setTestResult(null);
    invalidate();
    setConfig((old) => ({ ...old, [name]: value || null }));
    if (name === "service_url") {
      setServiceToken("");
    }
  }
  const persist = useCallback(async () => {
    if (!dirty || !saved) return saved;
    const version = revision.current;
    while (pending.current) {
      if (pending.current.version === version) return pending.current.request;
      await pending.current.request.catch(() => {});
    }
    if (version !== revision.current) return saved;
    setSaveError(null);
    const request = api({ type: "save_settings", config, service_token: serviceToken.trim() || null });
    pending.current = { version, request };
    try {
      const result = await request;
      if (version === revision.current) {
        setSaved(result); setConfig(result.config); setServiceToken(""); setDirty(false);
        toast.success(message("连接配置已保存"));
      }
      return result;
    } catch (e) { if (version === revision.current) setSaveError(e); throw e; }
    finally { if (pending.current?.request === request) pending.current = null; }
  }, [dirty, saved, config, serviceToken]);
  useEffect(() => {
    if (!flushRef || onConfigure) return;
    const flush = async () => {
      await persist();
    };
    flushRef.current = flush;
    return () => { if (flushRef.current === flush) flushRef.current = async () => {}; };
  });
  const save = useCallback(() => {
    if (!dirty || !saved || busy || locked.current) return;
    locked.current = true; setOperation("save");
    run(async () => {
      try { await persist(); }
      finally { locked.current = false; setOperation(null); }
    });
  }, [dirty, saved, busy, run, persist]);
  function clearToken() {
    if (busy || locked.current || dirty || pending.current || !saved?.config.service_url) return;
    locked.current = true; setOperation("clear"); setTestResult(null);
    const version = ++revision.current;
    run(async () => {
      try {
        const result = await api({type:"save_settings", config:saved.config, service_token:""});
        if (version !== revision.current) return;
        setSaved(result); setConfig(result.config); setServiceToken(""); setDirty(false); setSaveError(null);
        toast.success(message("连接配置已保存"));
      } catch (error) { if (version === revision.current) toast.error(error); }
      finally { locked.current = false; setOperation(null); }
    });
  }
  if (onConfigure) return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-6">
        <div className="min-w-0 space-y-2">
          <div className="flex items-center gap-2">
            <CardTitle>{t("AI 服务")}</CardTitle>
            {!error && <Badge role="status" variant={saved && !missingServiceSettings(saved).length ? "secondary" : "outline"}>
              {!saved ? t("加载中…") : missingServiceSettings(saved).length ? t("未配置") : t("已配置")}
            </Badge>}
          </div>
          {error != null && <p role="alert" className="break-words text-sm text-destructive">{errorMessage(error)}</p>}
        </div>
        <Button variant="outline" disabled={busy} onClick={onConfigure} className="shrink-0">{t("配置")}<ChevronRight /></Button>
      </CardHeader>
    </Card>
  );
  return (
    <Card>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={e => e.preventDefault()}
        >
          {error != null && (
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-3 text-sm text-destructive"
            >
              <span>{errorMessage(error)}</span>
              <Button type="button" variant="outline" disabled={reading} onClick={() => load()}>{t("重试")}</Button>
            </div>
          )}
          {waiting && <p role="status" className="text-sm text-muted-foreground">{t("读取配置耗时较长；可继续离线练习，请勿重复请求。")}</p>}
          {reading && !waiting && <p role="status" className="text-sm text-muted-foreground">{t("加载中…")}</p>}
          <p className="text-sm text-muted-foreground">{t("离开输入框时自动保存。AI 服务连接仅用于显式评分；离线练习无需配置。")}</p>
          <fieldset disabled={busy || operation !== null || !saved} className="min-w-0 space-y-4" onBlur={() => { void persist().catch(e => toast.error(e)); }}>
            <div className="space-y-2">
              <Label htmlFor="serviceUrl">{t("AI 服务地址")}</Label>
              <Input id="serviceUrl" type="url" autoCapitalize="none" enterKeyHint="done" autoComplete="off" spellCheck={false} placeholder="http://127.0.0.1:8000" value={config.service_url || ""} onChange={e => field("service_url", e.target.value)}/>
            </div>
            <div className="space-y-2">
              <Label htmlFor="serviceToken">{t("AI 服务访问令牌")}</Label>
              <Input
                id="serviceToken"
                type="password"
                autoCapitalize="none"
                enterKeyHint="done"
                autoComplete="new-password"
                spellCheck={false}
                placeholder={
                  configured !== false && config.service_url ? "********************************" : t("填写此服务对应的访问令牌")
                }
                value={serviceToken}
                onChange={(e) => { invalidate(); setTestResult(null); setServiceToken(e.target.value); }}
              />
              {saved && <p className="text-sm text-muted-foreground">{t(configured ? "此服务已有保存的令牌；留空会保留原令牌。" : "填写令牌后自动保存到此设备的安全存储。")}</p>}
            </div>
          </fieldset>
          {saveError != null && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 text-sm text-destructive"><span>{errorMessage(saveError)}</span><Button type="button" variant="outline" disabled={busy || operation !== null} onClick={save}>{t("重试保存")}</Button></div>}
          {testResult && <p role={testResult.error ? "alert" : "status"} className={testResult.error ? "text-sm text-destructive" : "workflow-note"}>{testResult.error ? errorMessage(testResult.error) : t("连接测试通过")}</p>}
          <div className="flex flex-wrap items-center justify-end gap-3 border-t pt-4">
          <Button variant="outline" type="button" disabled={busy || operation !== null || dirty || !saved?.config.service_url || configured === false} onClick={clearToken}>{t("清除已保存的访问令牌")}</Button>
          <Button variant="outline" type="button" disabled={busy || operation !== null || !saved || missing.length > 0} onClick={() => {
            if (locked.current) return;
            locked.current = true; setOperation("test"); setSaveError(null); setTestResult(null);
            const version = revision.current;
            run(async () => {
              try {
                await persist();
                await api({ type: "test_settings", config, service_token: null });
                if (version !== revision.current) return;
                setTestResult({});
                toast.success(message("连接测试通过"));
              } catch (e) { if (version === revision.current) { setTestResult({error:e}); toast.error(e); } }
              finally { locked.current = false; setOperation(null); }
            });
          }}>
            {operation === "test" ? <LoaderCircle className="animate-spin" /> : <PlugZap />}
            {operation === "test" ? t("测试中…") : t("测试")}
          </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
