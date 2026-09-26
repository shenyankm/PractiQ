import { list, t, useI18n } from "./i18n";
import type { ImportTaskContext } from "./ai-api";
import { AiTasks } from "./AiTasks";
import { useEffect, useState } from "react";
import { api, errorMessage, missingModelSettings, type Preview, type SettingsResult } from "./api";
import { Button } from "@/components/ui/button";

export function ImportPage({ busy, run, onPreview, onConfigure, onOpenBank }: {
  busy: boolean;
  run: (job: () => Promise<void>) => void;
  onPreview: (preview: Preview, context: ImportTaskContext) => void;
  onOpenBank: (bankId: string) => void;
  onConfigure: () => void;
}) {
  useI18n();
  const [settings, setSettings] = useState<SettingsResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setError(null);
    void api({ type: "settings" }).then(value => {
      if (active) setSettings(value);
    }).catch(e => { if (active) setError(e); });
    return () => { active = false; };
  }, [revision]);
  const missing = settings ? missingModelSettings(settings) : [];
  const ready = !!settings && !missing.length;
  return <AiTasks busy={busy} run={run} onPreview={onPreview} modelsReady={ready} onOpenBank={onOpenBank}>
        {error ? <div role="alert" className="space-y-2"><p>{errorMessage(error)}</p><Button variant="outline" disabled={busy} onClick={() => setRevision(n => n + 1)}>{t("重试读取配置")}</Button></div>
          : !settings ? <p role="status">{t("正在读取模型配置…")}</p>
          : !ready ? <div className="flex items-center justify-between gap-4 rounded-lg border bg-muted/30 p-4"><div><p className="font-medium">{t("先配置 AI 模型")}</p><p className="mt-1 text-sm text-muted-foreground">{t("还缺：{0}。题库 ZIP 请到设置中的“恢复备份”导入。", { 0: list(missing) })}</p></div><Button disabled={busy} onClick={onConfigure}>{t("配置 AI 模型")}</Button></div>
          : null}
  </AiTasks>;
}
