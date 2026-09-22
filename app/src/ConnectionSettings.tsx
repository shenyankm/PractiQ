import { list, message, t, useI18n } from "./i18n";
import { useEffect, useState } from "react";
import { toast } from "./notifications";
import { Save, KeyRound, ChevronRight } from "lucide-react";
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
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
export function ConnectionSettingsPanel({
  busy,
  run,
  onSaved,
  returnToImport = false,
  onConfigure,
}: {
  busy: boolean;
  run: (job: () => Promise<void>) => void;
  onSaved?: () => Promise<void>;
  returnToImport?: boolean;
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
  const [clearKey, setClearKey] = useState(false);
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
  const missing = missingModelSettings({ config, hasApiKey: !clearKey && (!!configured || !!apiKey.trim()) });
  function field(name: keyof ConnectionSettings, value: string) {
    setConfig((old) => ({ ...old, [name]: value || null }));
    if (name === "base_url") {
      setClearKey(false);
      setApiKey("");
    }
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
      <CardHeader>
        <CardTitle>{t("AI 模型")}</CardTitle>
        <CardDescription>{t("解析文档时调用配置的模型，可能产生费用。文件和图片保存在本机。")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              setSaveError(null);
              try {
              const result = await api<SettingsResult>({
                type: "save_settings",
                config,
                api_key: clearKey ? "" : apiKey.trim() || null,
              });
              setSaved(result);
              setConfig(result.config);
              setApiKey("");
              setClearKey(false);
              toast.success(message("连接配置已保存"));
              if (!missingModelSettings(result).length) await onSaved?.();
              } catch (e) { setSaveError(e); }
            });
          }}
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
          <fieldset disabled={busy || !saved} className="min-w-0 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="baseUrl">Base URL</Label>
              <Input id="baseUrl" type="url" autoComplete="off" spellCheck={false} placeholder="https://api.example.com/v1" value={config.base_url || ""} onChange={e => field("base_url", e.target.value)}/>
              <p className="text-xs text-muted-foreground">{t("从供应商的 API 文档复制兼容 OpenAI 的完整地址；本机回环服务允许 HTTP。")}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="modelId">{t("模型 ID")}</Label>
              <Input id="modelId" aria-describedby="model-help" placeholder={t("支持文本及图片输入的模型 ID")} autoComplete="off" value={config.model_id || ""} onChange={e => field("model_id", e.target.value)} />
              <p id="model-help" className="text-xs leading-5 text-muted-foreground">{t("解析和评分统一使用此模型，须支持文本及图片输入。请从供应商模型列表复制准确的 API 模型 ID。")}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="apiKey">API Key</Label>
              <Input
                id="apiKey"
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                disabled={clearKey}
                placeholder={
                  configured ? t("已保存，留空保持原值") : t("填写此地址对应的 API Key")
                }
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
              <p className="flex items-start gap-1.5 text-xs leading-5 text-muted-foreground">
                <KeyRound className="mt-1 size-3 shrink-0" />
                <span>{t("{0}密钥存入 macOS 钥匙串，不会导出到备份。", { 0: configured
                  ? t("该地址已有 API Key。")
                  : t("该地址尚未保存 API Key。") })}</span>
              </p>
              {configured && (
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={clearKey}
                    onCheckedChange={(v) => {
                      setClearKey(v === true);
                      if (v) setApiKey("");
                    }}
                  />{t("移除该地址已保存的 API Key")}</label>
              )}
            </div>
          </fieldset>
          <p role="status" className="text-sm">{missing.length ? t("解析配置还缺：{0}", { 0: list(missing) }) : t("解析所需字段已填写；保存配置不会调用模型，实际可用性将在主动解析时验证。")}</p>
          {saveError != null && <p role="alert" className="text-sm text-destructive">{t("{0}。请检查后重新保存。", { 0: errorMessage(saveError) })}</p>}
          <div className="flex items-center justify-between gap-4 border-t pt-4">
          <p className="max-w-md text-xs leading-5 text-muted-foreground">{t("更改连接配置会停止解析服务；旧任务可能因模型配置变化而无法继续。")}</p>
          <Button className="shrink-0" type="submit" disabled={busy || !saved}>
            <Save />
            {returnToImport && !missing.length ? t("保存并返回导入") : t("保存连接配置")}
          </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
