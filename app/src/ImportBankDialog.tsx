import { useEffect, useRef, useState } from "react";
import { api, type BankChoice, type Preview, type ImportDuplicates } from "./api";
import { ErrorNotice } from "./OperationFeedback";
import type { DocumentQualityIssue, DocumentQuestionSource } from "./contracts.generated";
import { message, t } from "./i18n";
import { toast } from "./notifications";
import { QuestionPreview } from "./QuestionPreview";
import { ImportDiagnostics } from "./ImportDiagnostics";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";

export function ImportBankDialog({ preview, banks, initialBank, busy, run, onClose, onImported }: {
  preview: Preview;
  banks: BankChoice[];
  initialBank: string;
  busy: boolean;
  run: (job: () => Promise<void>) => void;
  onClose: () => void;
  onImported: (bankId: string) => Promise<void>;
}) {
  const submitting = useRef(false);
  const [title, setTitle] = useState(preview.title);
  const [bank, setBank] = useState(initialBank);
  const [comparison, setComparison] = useState<{bank:string;value:ImportDuplicates} | null>(null);
  const [comparisonError, setComparisonError] = useState<unknown>(null), [retry, setRetry] = useState(0);
  const [policy, setPolicy] = useState("keep");
  const compared = bank === "new" || comparison?.bank === bank;
  useEffect(() => {
    if (bank === "new") return;
    let active = true;
    setComparison(null); setComparisonError(null);
    void api({type:"import_duplicates",ticket:preview.ticket,bank_id:bank}).then(value=>{if(active)setComparison({bank,value});}).catch(error=>{if(active)setComparisonError(error);});
    return ()=>{active=false;};
  },[bank,preview.ticket,retry]);
  const duplicates = comparison?.bank === bank ? comparison.value.groups : [];
  const duplicateCount = duplicates.reduce((sum,group)=>sum+group.count,0);
  const importTitle = title.trim() || (bank !== "new" ? banks.find(choice => choice.id === bank)?.title || "" : "");
  const processing = preview.processing as { quality?: { issues?: DocumentQualityIssue[] }; questionSources?: DocumentQuestionSource[] } | undefined;
  return (
    <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("导入题库")}</DialogTitle>
          <DialogDescription>{t("共 {0} 题，{1} 题待复核。", { 0: preview.count, 1: preview.reviewCount })}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-1">
          <Label htmlFor="import-bank">{t("导入到")}</Label>
          <NativeSelect id="import-bank" disabled={busy} value={bank} onValueChange={value => setBank(value)}>
            <NativeSelectOption value="new">{t("新建题库")}</NativeSelectOption>
            {banks.map(choice => <NativeSelectOption key={choice.id} value={choice.id}>{choice.title}</NativeSelectOption>)}
          </NativeSelect>
          {bank !== "new" && <div id="import-append-risk" className="space-y-3 rounded-lg border p-3 text-sm">
            <p>{t("保留已有题目与学习记录；相同完整结果不重复导入。")}</p>
            {comparisonError != null ? <div role="alert"><ErrorNotice error={comparisonError}/><Button variant="outline" onClick={()=>setRetry(value=>value+1)}>{t("重试重复题检查")}</Button></div> : !compared ? <p role="status">{t("正在检查重复题…")}</p> : <p role="status">{t("发现完全相同的 {0} 组 / {1} 题。",{0:duplicates.length,1:duplicateCount})}</p>}
            {!!duplicates.length && <><Label htmlFor="duplicate-policy">{t("重复题处理")}</Label><NativeSelect id="duplicate-policy" disabled={busy} value={policy} onValueChange={setPolicy}><NativeSelectOption value="keep">{t("保留重复题")}</NativeSelectOption><NativeSelectOption value="skip">{t("跳过完全相同的题组")}</NativeSelectOption></NativeSelect><details><summary className="cursor-pointer">{t("查看重复题")}</summary><ul className="mt-2 space-y-2">{duplicates.map(group=><li key={group.id}>{group.stem || t("原文未提供题干")} · {t("{0} 题",{0:group.count})}</li>)}</ul></details></>}
          </div>}
          {bank === "new" && <div className="space-y-2"><Label htmlFor="import-title">{t("题库名称")}</Label><Input id="import-title" disabled={busy} value={title} onChange={event => setTitle(event.target.value)} /></div>}
          <div className="rounded-lg border p-4 text-sm">
            <p>{t("已加载 {0} 张图片，缺失 {1} 个资源。", { 0: preview.assetCount, 1: preview.missingAssets.length })}</p>
          </div>
          {preview.status === "PARTIAL" && <p className="text-sm">{t("这是部分解析结果，可能未包含原文的全部题目。")}</p>}
          <ImportDiagnostics diagnostics={preview.importDiagnostics} />
          {preview.warnings.map((warning, index) => <p key={index} className="text-sm text-muted-foreground">{warning}</p>)}
          {preview.missingAssets.length > 0 && <details className="text-xs text-muted-foreground">
            <summary>{t("缺失资源详情")}</summary>
            {preview.missingAssets.map((missing, index) => <p className="mt-2 break-all" key={index}>{missing}</p>)}
          </details>}
          <QuestionPreview questions={preview.questions ?? []} groups={preview.groups} visuals={preview.visuals} reviewMode questionSources={processing?.questionSources} qualityIssues={processing?.quality?.issues} />
        </div>
        <DialogFooter className="shrink-0 border-t bg-background pt-3">
          <Button variant="outline" disabled={busy} onClick={onClose}>{t("取消")}</Button>
          <Button disabled={busy || !importTitle || !compared || (bank !== "new" && comparisonError != null)} aria-describedby={bank !== "new" ? "import-append-risk" : undefined} onClick={() => run(async () => {
            if (submitting.current) return;
            submitting.current = true;
            let result;
            try {
              try {
                result = await api({ type: "import", ticket: preview.ticket, bank_id: bank === "new" ? null : bank, title: importTitle, ...(bank !== "new" && policy === "skip" && duplicates.length ? {skip_duplicates:true,duplicate_check:comparison!.value.check} : {}) });
              } catch(error) { setComparison(null); setRetry(value=>value+1); throw error; }
            }
            finally { submitting.current = false; }
            onClose();
            toast.success(result.duplicate ? message("该题库已包含相同内容，本次导入已跳过。") : message("已导入 {0} 道题目", { 0: result.count }));
            if(result.skippedCount) toast.info(message("已跳过 {0} 道完全相同的题目。",{0:result.skippedCount}));
            await onImported(result.bankId);
          })}>{t("确认导入")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
