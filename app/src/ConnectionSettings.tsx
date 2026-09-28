import { message, t, useI18n } from "./i18n";
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { toast } from "./notifications";
import { PlugZap, LoaderCircle, ChevronRight } from "lucide-react";
import {
  api,
  errorMessage,
  missingModelSettings,
  type ConnectionSettings,
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
  const [config, setConfig] = useState<ConnectionSettings>({
    base_url: null,
    model_id: null,
  });
  const [apiKey, setApiKey] = useState("");
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
    saved && saved.config.base_url === config.base_url ? saved.hasApiKey : null;
  const missing = missingModelSettings({ config, hasApiKey: apiKey.trim() ? true : configured });
  function field(name: keyof ConnectionSettings, value: string) {
    invalidate();
    setConfig((old) => ({ ...old, [name]: value || null }));
    if (name === "base_url") {
      setApiKey("");
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
    const request = api({ type: "save_settings", config, api_key: apiKey.trim() || null });
    pending.current = { version, request };
    try {
      const result = await request;
      if (version === revision.current) {
        setSaved(result); setConfig(result.config); setApiKey(""); setDirty(false);
        toast.success(message("连接配置已保存"));
      }
      return result;
    } catch (e) { if (version === revision.current) setSaveError(e); throw e; }
    finally { if (pending.current?.request === request) pending.current = null; }
  }, [dirty, saved, config, apiKey]);
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
  function clearKey() {
    if (busy || locked.current || dirty || pending.current || !saved?.config.base_url) return;
    locked.current = true; setOperation("clear");
    const version = ++revision.current;
    run(async () => {
      try {
        const result = await api({type:"save_settings", config:saved.config, api_key:""});
        if (version !== revision.current) return;
        setSaved(result); setConfig(result.config); setApiKey(""); setDirty(false); setSaveError(null);
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
            <CardTitle>{t("AI 模型")}</CardTitle>
            {!error && <Badge role="status" variant={saved && !missingModelSettings(saved).length ? "secondary" : "outline"}>
              {!saved ? t("加载中…") : missingModelSettings(saved).length ? t("未配置") : t("已配置")}
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
              className="flex items-center justify-between gap-3 text-sm text-destructive"
            >
              <span>{errorMessage(error)}</span>
              <Button type="button" variant="outline" disabled={reading} onClick={() => load()}>{t("重试")}</Button>
            </div>
          )}
          {waiting && <p role="status" className="text-sm text-muted-foreground">{t("读取配置耗时较长；可继续离线练习，请勿重复请求。")}</p>}
          <p className="text-sm text-muted-foreground">{t("离开输入框时自动保存。请先暂停或等待正在解析的任务完成，再修改配置。")}</p>
          <fieldset disabled={busy || operation !== null || !saved} className="min-w-0 space-y-4" onBlur={() => { void persist().catch(e => toast.error(e)); }}>
            <div className="space-y-2">
              <div className="flex items-center gap-3"><Label htmlFor="baseUrl">Base URL</Label><span id="base-url-hint" className="text-xs text-muted-foreground">{t("OpenAI 兼容地址")}</span></div>
              <Input id="baseUrl" aria-describedby="base-url-hint" type="url" autoComplete="off" spellCheck={false} placeholder="https://api.example.com/v1" value={config.base_url || ""} onChange={e => field("base_url", e.target.value)}/>
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-3"><Label htmlFor="modelId">{t("模型 ID")}</Label><span id="model-id-hint" className="text-xs text-muted-foreground">{t("视觉模型")}</span></div>
              <Input id="modelId" aria-describedby="model-id-hint" placeholder={t("支持文本及图片输入的模型 ID")} autoComplete="off" value={config.model_id || ""} onChange={e => field("model_id", e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="apiKey">API Key</Label>
              <Input
                id="apiKey"
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                placeholder={
                  configured !== false && config.base_url ? "********************************" : t("填写此地址对应的 API Key")
                }
                value={apiKey}
                onChange={(e) => { invalidate(); setApiKey(e.target.value); }}
              />
            </div>
          </fieldset>
          {saveError != null && <div role="alert" className="flex items-center justify-between gap-3 text-sm text-destructive"><span>{errorMessage(saveError)}</span><Button type="button" variant="outline" disabled={busy || operation !== null} onClick={save}>{t("重试保存")}</Button></div>}
          <div className="flex items-center justify-end gap-4 border-t pt-4">
          <Button variant="outline" type="button" disabled={busy || operation !== null || dirty || !saved?.config.base_url || configured === false} onClick={clearKey}>{t("清除已保存的 API Key")}</Button>
          <Button variant="outline" type="button" disabled={busy || operation !== null || !saved || missing.length > 0} onClick={() => {
            if (locked.current) return;
            locked.current = true; setOperation("test"); setSaveError(null);
            const version = revision.current;
            run(async () => {
              try {
                await persist();
                await api({ type: "test_settings", config, api_key: null });
                if (version !== revision.current) return;
                toast.success(message("连接测试通过"));
              } catch (e) { if (version === revision.current) toast.error(e); }
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
