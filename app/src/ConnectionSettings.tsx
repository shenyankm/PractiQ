import { list, message, t, useI18n } from "./i18n";
import { useEffect, useRef, useState } from "react";
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
}: {
  busy: boolean;
  run: (job: () => Promise<void>) => void;
  onConfigure?: () => void;
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
  useEffect(() => () => { ++revision.current; }, []);
  function invalidate() { ++revision.current; setDirty(true); setSaveError(null); }
  const [saveError, setSaveError] = useState<unknown>(null);
  const [error, setError] = useState<unknown>(null);
  const load = () => {
    let active = true;
    void api<SettingsResult>({ type: "settings" })
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
  async function persist() {
    if (!dirty || !saved) return;
    const version = revision.current;
    setDirty(false); setSaveError(null);
    try {
      const result = await api<SettingsResult>({ type: "save_settings", config, api_key: apiKey.trim() || null });
      if (version === revision.current) {
        setSaved(result); setConfig(result.config);
      }
      toast.success(message("连接配置已保存"));
    } catch (e) { setSaveError(e); toast.error(e); }
  }
  function autosave() {
    if (!dirty || !saved || busy || locked.current) return;
    locked.current = true; setOperation("save");
    run(async () => {
      try { await persist(); }
      finally { locked.current = false; setOperation(null); }
    });
  }
  useEffect(() => {
    if (!dirty || busy || operation !== null) return;
    const timer = window.setTimeout(autosave, 600);
    return () => window.clearTimeout(timer);
  }, [config, apiKey, dirty, busy, operation]);
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
          {missing.length > 0 && <p role="status" className="text-sm">{t("解析配置还缺：{0}", { 0: list(missing) })}</p>}
          {saveError != null && <p role="alert" className="text-sm text-destructive">{errorMessage(saveError)}</p>}
          <div className="flex items-center justify-end gap-4 border-t pt-4">
          <Button variant="outline" type="button" disabled={busy || operation !== null || !saved || missing.length > 0} onClick={() => {
            if (locked.current) return;
            locked.current = true; setOperation("test"); setSaveError(null);
            const version = revision.current;
            run(async () => {
              try {
                await persist();
                await api({ type: "test_settings", config, api_key: apiKey.trim() || null });
                if (version !== revision.current) return;
                toast.success(message("连接测试通过"));
              } catch (e) { if (version === revision.current) { setSaveError(e); toast.error(e); } }
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
