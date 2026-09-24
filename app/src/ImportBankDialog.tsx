import { useRef, useState } from "react";
import { api, type BankChoice, type Preview } from "./api";
import { message, t } from "./i18n";
import { toast } from "./notifications";
import { QuestionPreview } from "./QuestionPreview";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export function ImportBankDialog({ preview, banks, initialBank, busy, run, onClose, onImported, onState }: {
  preview: Preview;
  banks: BankChoice[];
  initialBank: string;
  busy: boolean;
  run: (job: () => Promise<void>) => void;
  onState?: (state: "importing" | "failed", error?: unknown) => void;
  onClose: () => void;
  onImported: (bankId: string) => Promise<void>;
}) {
  const submitting = useRef(false);
  const [title, setTitle] = useState(preview.title);
  const [bank, setBank] = useState(initialBank);
  return (
    <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("导入题库")}</DialogTitle>
          <DialogDescription>{t("已识别 {0} 道题目，其中 {1} 道待复核，仍可直接练习。", { 0: preview.count, 1: preview.reviewCount })}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <QuestionPreview questions={preview.questions ?? []} groups={preview.groups} visuals={preview.visuals} />
          <Label htmlFor="import-bank">{t("导入到")}</Label>
          <Select value={bank} onValueChange={setBank}>
            <SelectTrigger id="import-bank"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="new">{t("新建题库")}</SelectItem>
              {banks.map(choice => <SelectItem key={choice.id} value={choice.id}>{choice.title}</SelectItem>)}
            </SelectContent>
          </Select>
          {bank === "new" && <Input aria-label={t("题库名称")} value={title} onChange={event => setTitle(event.target.value)} />}
          <div className="rounded-lg border p-4 text-sm">
            <p>{t("已加载 {0} 张图片，缺失 {1} 个资源。", { 0: preview.assetCount, 1: preview.missingAssets.length })}</p>
          </div>
          {preview.status === "PARTIAL" && <p className="text-sm">{t("这是部分解析结果，可能未包含原文的全部题目。")}</p>}
          {preview.warnings.map((warning, index) => <p key={index} className="text-sm text-muted-foreground">{warning}</p>)}
          {preview.missingAssets.length > 0 && <details className="text-xs text-muted-foreground">
            <summary>{t("缺失资源详情")}</summary>
            {preview.missingAssets.map((missing, index) => <p className="mt-2 break-all" key={index}>{missing}</p>)}
          </details>}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>{t("取消")}</Button>
          <Button disabled={busy || !title.trim()} onClick={() => run(async () => {
            if (submitting.current) return;
            submitting.current = true;
            onState?.("importing");
            let result;
            try {
              result = await api({ type: "import", ticket: preview.ticket, bank_id: bank === "new" ? null : bank, title });
            } catch (error) { onState?.("failed", error); throw error; }
            finally { submitting.current = false; }
            onClose();
            await onImported(result.bankId);
            toast.success(result.duplicate ? message("此题库已导入相同内容，本次已跳过") : message("已导入 {0} 道题目", { 0: result.count }));
          })}>{t("确认导入")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
