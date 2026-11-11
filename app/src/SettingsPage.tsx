import { useEffect, useRef, useState, type ComponentProps } from "react";
import { Download, ArchiveRestore } from "lucide-react";
import { api, type BackupStatus } from "./api";
import { date, message, t } from "./i18n";
import { ErrorNotice } from "./OperationFeedback";
import { toast } from "./notifications";
import { ConnectionSettingsPanel } from "./ConnectionSettings";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

export function SettingsPage({ busy, run, flushRef, revision, version, onConfigure, onPickImport, onRestore, restoreOpen, onRestoreOpenChange }: {
  busy: boolean;
  run: (job: () => Promise<void>) => void;
  flushRef: ComponentProps<typeof ConnectionSettingsPanel>["flushRef"];
  revision: number;
  version: string | undefined;
  onConfigure: () => void;
  onPickImport: () => Promise<void>;
  onRestore: (recoverAssets: boolean, trigger: HTMLButtonElement | null) => void;
  restoreOpen: boolean;
  onRestoreOpenChange: (open: boolean) => void;
}) {
  const restoreTrigger = useRef<HTMLButtonElement>(null);
  const [backup, setBackup] = useState<BackupStatus | null>(null), [backupError, setBackupError] = useState<unknown>(null), [backupRevision, setBackupRevision] = useState(0);
  useEffect(() => {
    let active = true;
    void api({type:"backup_status"}).then(status=>{if(active){setBackup(status);setBackupError(null);}}).catch(error=>{if(active)setBackupError(error);});
    return ()=>{active=false;};
  },[revision,backupRevision]);
  return <div className="mx-auto max-w-3xl space-y-6">
    <ConnectionSettingsPanel key={revision} busy={busy} run={run} onConfigure={onConfigure} flushRef={flushRef} />
    <Card>
      <CardHeader>
        <CardTitle><h2>{t("学习数据备份")}</h2></CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {backupError != null && <div role="alert"><ErrorNotice error={backupError}/><Button variant="outline" disabled={busy} onClick={()=>setBackupRevision(value=>value+1)}>{t("重试")}</Button></div>}
        {backup && <div className="space-y-1 text-sm" role="status"><p>{backup.lastBackupAt == null ? t("尚未导出学习数据备份。") : t("上次成功备份：{0}",{0:date(backup.lastBackupAt)})}</p>{backup.due && backup.lastBackupAt != null && <p>{t("有新记录，建议备份。")}</p>}</div>}
        <div className="flex flex-wrap gap-3">
          <Button disabled={busy} onClick={() => run(async () => {
            const result = await api({ type: "backup" });
            if (result) { toast.success(message("备份已保存：{0}", { 0: result.path })); setBackupRevision(value=>value+1); if(result.reminderError) toast.info(message("备份文件已保存，但备份提醒状态未更新。")); }
          })}><Download />{t("导出备份")}</Button>
          <DropdownMenu open={restoreOpen} onOpenChange={onRestoreOpenChange}>
            <DropdownMenuTrigger asChild><Button ref={restoreTrigger} variant="outline" disabled={busy}><ArchiveRestore />{t("导入与恢复")}</Button></DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-48">
              <DropdownMenuItem aria-label={t("导入题库 ZIP")} className="flex-col items-start" disabled={busy} onSelect={() => run(onPickImport)}>{t("导入题库 ZIP")}<span className="text-xs text-muted-foreground">{t("追加题库，不替换已有学习记录")}</span></DropdownMenuItem>
              <DropdownMenuItem aria-label={t("恢复学习数据备份")} className="flex-col items-start" disabled={busy} onSelect={()=>onRestore(false, restoreTrigger.current)}>{t("恢复学习数据备份")}<span className="text-xs text-muted-foreground">{t("替换全部本地数据，操作前需确认")}</span></DropdownMenuItem>
              <DropdownMenuItem aria-label={t("修复资源并恢复备份")} className="flex-col items-start" disabled={busy} onSelect={()=>onRestore(true, restoreTrigger.current)}>{t("修复资源并恢复备份")}<span className="text-xs text-muted-foreground">{t("资源损坏时使用，仍会替换全部本地数据")}</span></DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <details className="text-sm text-muted-foreground">
          <summary className="cursor-pointer">{t("备份范围与注意事项")}</summary>
          <p className="mt-2">{t("包含题库、图片、收藏、作答和评分记录。不包含原始文档、云端任务和模型密钥。请定期保存到其他位置。")}</p>
        </details>
      </CardContent>
    </Card>
    <Card>
      <CardHeader><CardTitle>{t("版本信息")}</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p>{t("版本：{0}", { 0: version || "—" })}</p>
        <p className="break-all select-text">{t("源码地址：{0}", { 0: "https://github.com/shenyankm/PractiQ" })}</p>
      </CardContent>
    </Card>
  </div>;
}
