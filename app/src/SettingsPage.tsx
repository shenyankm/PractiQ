import type { ComponentProps } from "react";
import { Upload } from "lucide-react";
import { api } from "./api";
import { message, t } from "./i18n";
import { toast } from "./notifications";
import { ConnectionSettingsPanel } from "./ConnectionSettings";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

export function SettingsPage({ busy, run, flushRef, revision, version, onConfigure, onPickImport, onRestore }: {
  busy: boolean;
  run: (job: () => Promise<void>) => void;
  flushRef: ComponentProps<typeof ConnectionSettingsPanel>["flushRef"];
  revision: number;
  version: string | undefined;
  onConfigure: () => void;
  onPickImport: () => Promise<void>;
  onRestore: () => void;
}) {
  return <div className="max-w-3xl space-y-6">
    <ConnectionSettingsPanel key={revision} busy={busy} run={run} onConfigure={onConfigure} flushRef={flushRef} />
    <Card>
      <CardHeader>
        <CardTitle>{t("学习数据备份")}</CardTitle>
        <CardDescription>{t("包含题库、图片、收藏、作答和评分记录。不包含原始文档、AI 任务及 API Key；在其他设备恢复后需重新配置密钥。请定期保存到其他位置。")}</CardDescription>
      </CardHeader>
      <CardContent className="flex gap-3">
        <Button disabled={busy} onClick={() => run(async () => {
          const result = await api({ type: "backup" });
          if (result) toast.success(message("备份已保存：{0}", { 0: result.path }));
        })}><Upload />{t("导出备份")}</Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="outline" disabled={busy}>{t("恢复备份")}</Button></DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-48">
            <DropdownMenuItem disabled={busy} onSelect={() => run(onPickImport)}>{t("导入题库 ZIP")}</DropdownMenuItem>
            <DropdownMenuItem disabled={busy} onSelect={onRestore}>{t("恢复学习数据备份")}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
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
