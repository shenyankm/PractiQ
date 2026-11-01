import type { BankImportDiagnostic } from "./contracts.generated";
import { useState } from "react";
import { t } from "./i18n";

export function ImportDiagnostics({ diagnostics = [] }: { diagnostics?: BankImportDiagnostic[] }) {
  const [open, setOpen] = useState(false);
  if (!diagnostics.length) return null;
  return <details className="text-sm" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer">{t("导入解析诊断")}</summary>
    <p className="mt-2 text-muted-foreground">{t("保留导入时各快照的解析状态、失败单元和复核原因，供对照原文检查。")}</p>
    {open && diagnostics.map((diagnostic, index) => <div key={index} className="mt-3 space-y-2">
      {diagnostic.status === "PARTIAL" && <p>{t("这是部分解析结果，可能未包含原文的全部题目。")}</p>}
      <pre tabIndex={0} className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs">{JSON.stringify(diagnostic, null, 2)}</pre>
    </div>)}
  </details>;
}
