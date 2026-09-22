import { list, t, useI18n } from "./i18n";
import { AiTasks } from "./AiTasks";
import { useEffect, useState } from "react";
import { api, errorMessage, missingModelSettings, type Preview, type SettingsResult } from "./api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function ImportPage({ busy, run, onPickJson, onPreview, onConfigure }: {
  busy: boolean;
  run: (job: () => Promise<void>) => void;
  onPickJson: () => Promise<void>;
  onPreview: (preview: Preview) => void;
  onConfigure: () => void;
}) {
  useI18n();
  const [settings, setSettings] = useState<SettingsResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setError(null);
    void api<SettingsResult>({ type: "settings" }).then(value => {
      if (active) setSettings(value);
    }).catch(e => { if (active) setError(e); });
    return () => { active = false; };
  }, [revision]);
  const missing = settings ? missingModelSettings(settings) : [];
  const ready = !!settings && !missing.length;
  return <div className="space-y-6">
    <Card>
      <CardHeader>
        <CardTitle>{t("导入已有题库")}</CardTitle>
        <CardDescription>{t("支持 PractiQ 题库 ZIP，包含题目与图片，无需 AI 解析或模型配置。")}</CardDescription>
      </CardHeader>
      <CardContent><Button disabled={busy} onClick={() => run(onPickJson)}>{t("选择题库 ZIP")}</Button></CardContent>
    </Card>
    <Card>
      <CardHeader>
        <CardTitle>{t("从文档创建题库")}</CardTitle>
        <CardDescription>{t("支持 PDF（.pdf）、文本（.txt）、表格文本（.csv），以及图片（.png、.jpg、.jpeg）。单个文件最大 25 MiB。")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <details className="text-sm text-muted-foreground">
          <summary className="cursor-pointer">{t("暂不支持 Word 文件，请先导出为 PDF")}</summary>
          <p className="mt-2 leading-relaxed">{t("Word（.doc、.docx）的排版可能随字体和软件变化。请在 Word 或 WPS 中选择“导出为 PDF”或“另存为 PDF”，以保留题目、公式和图片的位置。")}</p>
        </details>
        {error ? <div role="alert" className="space-y-2"><p>{errorMessage(error)}</p><Button variant="outline" disabled={busy} onClick={() => setRevision(n => n + 1)}>{t("重试读取配置")}</Button></div>
          : !settings ? <p role="status">{t("正在读取模型配置…")}</p>
          : !ready ? <div className="flex items-center justify-between gap-4 rounded-lg border bg-muted/30 p-4"><div><p className="font-medium">{t("先配置 AI 模型")}</p><p className="mt-1 text-sm text-muted-foreground">{t("还缺：{0}。已有 ZIP 题库可直接离线导入。", { 0: list(missing) })}</p></div><Button disabled={busy} onClick={onConfigure}>{t("配置 AI 模型")}</Button></div>
          : <p className="text-sm text-muted-foreground">{t("模型 ID：{0}", { 0: settings.config.model_id })}</p>}
        <AiTasks busy={busy} run={run} onPreview={onPreview} modelsReady={ready} />
      </CardContent>
    </Card>
  </div>;
}
