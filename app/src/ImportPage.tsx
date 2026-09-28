import { list, t, useI18n } from "./i18n";
import type { ImportTaskContext } from "./ai-api";
import { AiTasks } from "./AiTasks";
import { useEffect, useState } from "react";
import { api, errorMessage, missingModelSettings, type Preview, type SettingsResult } from "./api";
import { Button } from "@/components/ui/button";

export function ImportPage({ tabsHost, busy, run, onPreview, onConfigure, onOpenBank, onOpenZipSettings }: {
  tabsHost?: HTMLDivElement | null;
  busy: boolean;
  run: (job: () => Promise<void>) => void;
  onPreview: (preview: Preview, context: ImportTaskContext) => void;
  onOpenBank: (bankId: string) => void;
  onConfigure: () => void;
  onOpenZipSettings: () => void;
}) {
  useI18n();
  const [settings, setSettings] = useState<SettingsResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [revision, setRevision] = useState(0);
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    let active = true;
    setError(null);
    setWaiting(false);
    const timer = setTimeout(() => { if (active) setWaiting(true); }, 8000);
    void api({ type: "settings" }).then(value => {
      if (active) setSettings(value);
    }).catch(e => { if (active) setError(e); }).finally(() => clearTimeout(timer));
    return () => { active = false; clearTimeout(timer); };
  }, [revision]);
  const missing = settings ? missingModelSettings(settings) : [];
  const ready = !!settings && !missing.length;
  return <AiTasks tabsHost={tabsHost} busy={busy} run={run} onPreview={onPreview} modelsReady={ready} officeMode="pdf" onOpenBank={onOpenBank}>
        <div className="space-y-2 rounded-lg border p-4 text-sm">
          <p className="text-muted-foreground">{t("解析会在确认后调用所配置的模型；查看已有结果和导入 ZIP 无需模型配置。")}</p>
          <Button type="button" variant="link" className="h-auto whitespace-normal px-0 text-left" onClick={onOpenZipSettings}>{t("已有题库 ZIP？前往设置导入（追加，不替换学习记录）")}</Button>
        </div>
        {error ? <div role="alert" className="space-y-2"><p>{errorMessage(error)}</p><Button type="button" variant="outline" disabled={busy} onClick={() => setRevision(n => n + 1)}>{t("重试读取配置")}</Button></div>
          : !settings ? <p role="status">{waiting ? t("读取模型配置耗时较长。不会重复发送请求；你仍可查看已有任务或前往设置导入 ZIP。") : t("正在读取模型配置…")}</p>
          : !ready ? <div className="flex items-center justify-between gap-4 rounded-lg border bg-muted/30 p-4"><div><p className="font-medium">{t("解析新文档前，请配置 AI 模型")}</p><p className="mt-1 text-sm text-muted-foreground">{t("还缺：{0}", { 0: list(missing) })}</p></div><Button type="button" disabled={busy} onClick={onConfigure}>{t("配置 AI 模型")}</Button></div>
          : null}
  </AiTasks>;
}
