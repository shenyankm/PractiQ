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
    oss_url: null,
  });
  const [apiKey, setApiKey] = useState("");
  const [dirty, setDirty] = useState(false);
  const [operation, setOperation] = useState<"test" | "save" | null>(null);
  const locked = useRef(false);
  const revision = useRef(0);
  const pending = useRef<{ version: number; request: Promise<SettingsResult> } | null>(null);
  useEffect(() => () => { ++revision.current; }, []);
  function invalidate() { ++revision.current; setDirty(true); setSaveError(null); }
  const [saveError, setSaveError] = useState<unknown>(null);
  const [error, setError] = useState<unknown>(null);
  const load = () => {
    let active = true;
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
      });
    return () => {
      active = false;
    };
  };
  useEffect(load, []);
  const configured =
    saved?.hasApiKey && saved.config.base_url === config.base_url;
  const missing = missingModelSettings({ config, hasApiKey: !!configured || !!apiKey.trim() });
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
    if (pending.current?.version === version) return pending.current.request;
    if (pending.current) await pending.current.request.catch(() => {});
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
    const flush = async () => { await persist(); };
    flushRef.current = flush;
    return () => { if (flushRef.current === flush) flushRef.current = async () => {}; };
  });
  const autosave = useCallback((retry = false) => {
    if ((!retry && saveError != null) || !dirty || !saved || busy || locked.current) return;
    locked.current = true; setOperation("save");
    run(async () => {
      try { await persist(); }
      finally { locked.current = false; setOperation(null); }
    });
  }, [saveError, dirty, saved, busy, run, persist]);
  useEffect(() => {
    if (!dirty || saveError != null || busy || operation !== null) return;
    const timer = window.setTimeout(() => autosave(), 600);
    return () => window.clearTimeout(timer);
  }, [config, apiKey, dirty, saveError, busy, operation, autosave]);
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
          onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) autosave(); }}
        >
          {error != null && (
            <div
              role="alert"
              className="flex items-center justify-between gap-3 text-sm text-destructive"
            >
              <span>{errorMessage(error)}</span>
              <Button type="button" variant="outline" onClick={() => load()}>{t("重试")}</Button>
            </div>
          )}
          <fieldset disabled={busy || operation !== null || !saved} className="min-w-0 space-y-4">
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
                  configured ? "********************************" : t("填写此地址对应的 API Key")
                }
                value={apiKey}
                onChange={(e) => { invalidate(); setApiKey(e.target.value); }}
              />
            </div>
          </fieldset>
          {saveError != null && <div role="alert" className="flex items-center justify-between gap-3 text-sm text-destructive"><span>{errorMessage(saveError)}</span><Button type="button" variant="outline" disabled={busy || operation !== null} onClick={() => autosave(true)}>{t("重试保存")}</Button></div>}
          <div className="flex items-center justify-end gap-4 border-t pt-4">
          <Button variant="outline" type="button" disabled={busy || operation !== null || !saved || missing.length > 0} onClick={() => {
            if (locked.current) return;
            locked.current = true; setOperation("test"); setSaveError(null);
            const version = revision.current;
            run(async () => {
              try {
                const persisted = await persist();
                if (!persisted) return;
                await api({ type: "test_settings", config: persisted.config, api_key: null });
                if (version !== revision.current) return;
                toast.success(message("连接测试通过"));
              } catch (e) { if (version === revision.current) toast.error(e); }
              finally { locked.current = false; setOperation(null); }
            });
          }}>
            {operation === "test" ? <LoaderCircle className="animate-spin" /> : <PlugZap />}
            {operation === "test" ? t("测试中…") : t("测试")}
          </Button>
          {operation === "save" && <span role="status" className="text-sm text-muted-foreground">{t("保存中…")}</span>}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
