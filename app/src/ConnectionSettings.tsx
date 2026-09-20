import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Save, KeyRound } from "lucide-react";
import {
  api,
  errorMessage,
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
export function ConnectionSettingsPanel({
  busy,
  run,
}: {
  busy: boolean;
  run: (job: () => Promise<void>) => void;
}) {
  const [saved, setSaved] = useState<SettingsResult | null>(null);
  const [config, setConfig] = useState<ConnectionSettings>({
    base_url: null,
    model_id: null,
    text_model: null,
    vision_model: null,
    oss_url: null,
  });
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
        if (active) setError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  };
  useEffect(load, []);
  const configured =
    saved?.hasApiKey && saved.config.base_url === config.base_url;
  function field(name: keyof ConnectionSettings, value: string) {
    setConfig((old) => ({ ...old, [name]: value || null }));
    if (name === "base_url") {
      setClearKey(false);
      setApiKey("");
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>AI 模型</CardTitle>
        <CardDescription>
          解析文档时调用配置的模型，可能产生费用。文件和图片保存在本机。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              const result = await api<SettingsResult>({
                type: "save_settings",
                config,
                api_key: clearKey ? "" : apiKey.trim() || null,
              });
              setSaved(result);
              setConfig(result.config);
              setApiKey("");
              setClearKey(false);
              toast.success("连接配置已保存");
            });
          }}
        >
          {error && (
            <div
              role="alert"
              className="flex items-center justify-between gap-3 text-sm text-destructive"
            >
              <span>{error}</span>
              <Button type="button" variant="outline" onClick={() => load()}>
                重试
              </Button>
            </div>
          )}
          <fieldset disabled={busy || !saved} className="min-w-0 space-y-4">
            <div className="grid grid-cols-3 items-start gap-4">
            <div className="col-span-2 min-w-0 space-y-2">
              <Label htmlFor="baseUrl">Base URL</Label>
              <Input
                id="baseUrl"
                type="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="https://api.example.com/v1"
                value={config.base_url || ""}
                onChange={(e) => field("base_url", e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                填写完整的模型 API 地址；本机服务支持 http://127.0.0.1 地址。
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="providerPreset">供应商预设</Label>
              <select id="providerPreset" className="h-8 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50" defaultValue="" onChange={e=>{if(e.target.value) field("base_url",e.target.value)}}>
                <option value="">自定义兼容 OpenAI 的地址</option>
                <option value="https://dashscope.aliyuncs.com/compatible-mode/v1">DashScope</option>
                <option value="https://api.deepseek.com">DeepSeek</option>
                <option value="https://api.moonshot.cn/v1">Moonshot</option>
              </select>
            </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
            {([['text_model','文本模型'],['vision_model','视觉模型']] as const).map(([key,label])=><div key={key} className="space-y-2">
              <Label htmlFor={key}>{label}</Label>
              <Input id={key} autoComplete="off" value={config[key] || ''} onChange={e=>field(key,e.target.value)} />
            </div>)}
            </div>
            {(!config.text_model || !config.vision_model) && <p className="text-xs text-muted-foreground">开始解析前需分别填写文本模型与视觉模型。</p>}
            <div className="space-y-2">
              <Label htmlFor="apiKey">API Key</Label>
              <Input
                id="apiKey"
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                disabled={clearKey}
                placeholder={
                  configured ? "已保存，留空保持原值" : "填写 API Key（可留空）"
                }
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
              <p className="flex items-start gap-1.5 text-xs leading-5 text-muted-foreground">
                <KeyRound className="mt-1 size-3 shrink-0" />
                <span>
                {configured
                  ? "该地址已有 API Key。"
                  : "该地址尚未保存 API Key。"}
                密钥存入 macOS 钥匙串，不会导出到备份。
                </span>
              </p>
              {configured && (
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={clearKey}
                    onCheckedChange={(v) => {
                      setClearKey(v === true);
                      if (v) setApiKey("");
                    }}
                  />
                  移除该地址已保存的 API Key
                </label>
              )}
            </div>
          </fieldset>
          <div className="flex items-center justify-between gap-4 border-t pt-4">
          <p className="max-w-md text-xs leading-5 text-muted-foreground">更改连接配置会停止解析服务；旧任务可能因模型配置变化而无法继续。</p>
          <Button className="shrink-0" type="submit" disabled={busy || !saved}>
            <Save />
            保存连接配置
          </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
