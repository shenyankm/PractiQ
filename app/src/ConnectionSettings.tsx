import { message, t, useI18n } from "./i18n";
import { useCallback, useContext, useEffect, useRef, useState, type MutableRefObject } from "react";
import { toast } from "./notifications";
import { ErrorNotice, OperationFailure } from "./OperationFeedback";
import { PlugZap, LoaderCircle, ChevronRight } from "lucide-react";
import {
  api,
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
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
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
    model: { base_url: null, model_id: null },
  });
  const [serviceToken, setServiceToken] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [operation, setOperation] = useState<"test" | "save" | "clear" | null>(null);
  const locked = useRef(false);
  const revision = useRef(0);
  const pending = useRef<{ version: number; request: Promise<SettingsResult> } | null>(null);
  useEffect(() => () => { ++revision.current; }, []);
  function invalidate() { setJustSaved(false); ++revision.current; setDirty(true); setSaveError(null); setClearError(null); }
  const [saveError, setSaveError] = useState<unknown>(null);
  const [clearError, setClearError] = useState<unknown>(null);
  const operationFailure = useContext(OperationFailure);
  useEffect(() => {
    // A modal can hide these fields; only deduplicate a visible inline failure.
    if (saveError != null && operationFailure?.error === saveError && !operationFailure.dialogOpen) operationFailure.dismiss();
  }, [saveError, operationFailure]);
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
          setConfig(result.config.model || result.config.service_url ? result.config : { ...result.config, model: { base_url: null, model_id: null } });
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
  const direct = !!config.model;
  const endpoint = direct ? config.model?.base_url : config.service_url;
  const configured = direct
    ? saved?.config.model?.base_url === endpoint ? saved?.hasApiKey ?? null : false
    : saved && saved.config.service_url === config.service_url ? saved.hasServiceToken : null;
  const missing = missingServiceSettings({ config, hasServiceToken: serviceToken.trim() ? true : configured, hasApiKey: serviceToken.trim() ? true : configured });
  function field(name: "service_url", value: string) {
    setTestResult(null);
    invalidate();
    setConfig((old) => ({ ...old, [name]: value || null }));
    if (name === "service_url") {
      setServiceToken("");
    }
  }
  function modelField(name: "base_url" | "model_id", value: string) {
    setTestResult(null); invalidate();
    setConfig(old => ({ ...old, model: { base_url: null, model_id: null, ...old.model, [name]: value || null } }));
    if (name === "base_url") setServiceToken("");
  }
  const persist = useCallback(async () => {
    if (!dirty || !saved) return saved;
    const version = revision.current;
    while (pending.current) {
      if (pending.current.version === version) return pending.current.request;
      await pending.current.request.catch(() => {});
    }
    if (version !== revision.current) return saved;
    setSaveError(null); setSaving(true);
    const request = api({ type: "save_settings", config, service_token: config.model ? null : serviceToken.trim() || null, ...(config.model ? { api_key: serviceToken.trim() || null } : {}) });
    pending.current = { version, request };
    try {
      const result = await request;
      if (version === revision.current) {
        setSaved(result); setConfig(result.config); setServiceToken(""); setDirty(false); setJustSaved(true);
        toast.success(message("连接配置已保存"));
      }
      return result;
    } catch (e) { if (version === revision.current) setSaveError(e); throw e; }
    finally { if (pending.current?.request === request) { pending.current = null; setSaving(false); } }
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
    if (busy || locked.current || dirty || pending.current || !saved || !endpoint) return;
    locked.current = true; setOperation("clear"); setTestResult(null); setClearError(null);
    const version = ++revision.current;
    run(async () => {
      try {
        const result = await api({type:"save_settings", config:saved.config, service_token:direct ? null : "", ...(direct ? {api_key:""} : {})});
        if (version !== revision.current) return;
        setSaved(result); setConfig(result.config); setServiceToken(""); setDirty(false); setSaveError(null);
        toast.success(message("连接配置已保存"));
      } catch (error) { if (version === revision.current) setClearError(error); }
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
          {error != null && <div role="alert" className="text-destructive"><ErrorNotice error={error} /></div>}
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
              className="flex flex-wrap items-start justify-between gap-3 text-sm text-destructive"
            >
              <div className="min-w-0 flex-1"><ErrorNotice error={error} /></div>
              <Button type="button" variant="outline" disabled={reading} onClick={() => load()}>{t("重试")}</Button>
            </div>
          )}
          {waiting && <p role="status" className="text-sm text-muted-foreground">{t("读取配置耗时较长；可继续离线练习，请勿重复请求。")}</p>}
          {reading && !waiting && <p role="status" className="text-sm text-muted-foreground">{t("加载中…")}</p>}
          <p className="text-sm text-muted-foreground">{t("仅 AI 评分需要配置；离开输入框自动保存。")}</p>
          <fieldset disabled={busy || operation !== null || !saved} className="min-w-0 space-y-4" onBlur={() => { void persist().catch(() => { /* persist retains the error beside these fields. */ }); }}>
            <div className="space-y-2">
              <Label htmlFor="gradingConnection">{t("评分连接方式")}</Label>
              <NativeSelect id="gradingConnection" value={direct ? "direct" : "service"} onValueChange={value => {
                invalidate(); setTestResult(null); setServiceToken("");
                setConfig(old => value === "direct" ? { ...old, model: saved?.config.model ?? {base_url:null, model_id:null} } : {service_url:old.service_url});
              }}>
                <NativeSelectOption value="direct">{t("直连模型 API")}</NativeSelectOption>
                <NativeSelectOption value="service">{t("独立 AI 服务")}</NativeSelectOption>
              </NativeSelect>
            </div>
            {direct ? <>
              <p className="text-sm text-muted-foreground">{t("使用兼容 OpenAI 的 Chat Completions API，无需部署评分服务。评分时会发送当前题目、相关材料、图片和作答，可能产生模型费用。")}</p>
              <div className="space-y-2">
                <Label htmlFor="modelUrl">{t("模型 API 地址")}</Label>
                <Input id="modelUrl" type="url" autoCapitalize="none" enterKeyHint="done" autoComplete="off" spellCheck={false} placeholder="https://api.example.com/v1" value={config.model?.base_url || ""} onChange={e => modelField("base_url", e.target.value)}/>
              </div>
              <div className="space-y-2">
                <Label htmlFor="modelId">{t("模型 ID")}</Label>
                <Input id="modelId" autoCapitalize="none" enterKeyHint="done" autoComplete="off" spellCheck={false} value={config.model?.model_id || ""} onChange={e => modelField("model_id", e.target.value)}/>
              </div>
            </> :
            <div className="space-y-2">
              <Label htmlFor="serviceUrl">{t("AI 服务地址")}</Label>
              <Input id="serviceUrl" type="url" autoCapitalize="none" enterKeyHint="done" autoComplete="off" spellCheck={false} placeholder="http://127.0.0.1:8000" value={config.service_url || ""} onChange={e => field("service_url", e.target.value)}/>
            </div>
            }
            <div className="space-y-2">
              <Label htmlFor="serviceToken">{t(direct ? "模型 API Key" : "AI 服务访问令牌")}</Label>
              <Input
                id="serviceToken"
                type="password"
                autoCapitalize="none"
                enterKeyHint="done"
                autoComplete="new-password"
                spellCheck={false}
                placeholder={
                  configured !== false && endpoint ? "********************************" : t(direct ? "填写此模型服务对应的 API Key" : "填写此服务对应的访问令牌")
                }
                value={serviceToken}
                onChange={(e) => { invalidate(); setTestResult(null); setServiceToken(e.target.value); }}
              />
              {saved && <p className="text-sm text-muted-foreground">{t(configured ? direct ? "API Key 已保存；留空保留。" : "令牌已保存；留空保留。" : "离开输入框后自动安全保存。")}</p>}
            </div>
          </fieldset>
          {saved && <p role="status" className="text-sm text-muted-foreground">{saving ? t("正在保存配置…") : saveError != null ? t("配置未保存") : dirty ? t("有未保存的修改") : justSaved ? t("连接配置已保存") : t("配置已读取")}</p>}
          {saved && <p role="status" className="text-sm">{operation === "test" ? t("测试中…") : testResult ? t(testResult.error ? "连接测试失败" : "连接测试通过") : missing.length ? t("未配置") : t("已配置 · 尚未测试")}</p>}
          {saveError != null && <div role="alert" className="flex flex-wrap items-start justify-between gap-3 text-sm text-destructive"><div className="min-w-0 flex-1"><ErrorNotice error={saveError} /></div><Button type="button" variant="outline" disabled={busy || operation !== null} onClick={save}>{t("重试保存")}</Button></div>}
          {testResult && (testResult.error ? <div role="alert" className="text-destructive"><ErrorNotice error={testResult.error} /></div> : null)}
          {clearError != null && <div role="alert" className="text-destructive"><ErrorNotice error={clearError} /></div>}
          {direct && <p className="text-sm text-muted-foreground">{t("测试连接仅读取模型列表，不进行评分。含图题需要支持图片的模型；评分 JSON 无效时保持未判定。")}</p>}
          <div className="flex flex-wrap items-center justify-end gap-3 border-t pt-4">
          <Button variant="outline" type="button" disabled={busy || operation !== null || dirty || !saved || !endpoint || configured === false} onClick={clearToken}>{t(direct ? "清除已保存的 API Key" : "清除已保存的访问令牌")}</Button>
          <Button variant="outline" type="button" disabled={busy || operation !== null || !saved || missing.length > 0} onClick={() => {
            if (locked.current) return;
            locked.current = true; setOperation("test"); setSaveError(null); setTestResult(null);
            const version = revision.current;
            run(async () => {
              let persisted = false;
              try {
                await persist();
                persisted = true;
                await api({ type: "test_settings", config, service_token: null, ...(direct ? { api_key: null } : {}) });
                if (version !== revision.current) return;
                setTestResult({});
                toast.success(message("连接测试通过"));
              } catch (e) { if (version === revision.current && persisted) setTestResult({error:e}); }
              finally { locked.current = false; setOperation(null); }
            });
          }}>
            {operation === "test" ? <LoaderCircle className="animate-spin" /> : <PlugZap />}
            {operation === "test" ? t("测试中…") : t("测试连接")}
          </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
