import { createContext, useContext, useState } from "react";
import { errorMessage } from "./api";
import { t, useI18n } from "./i18n";
import { Button } from "@/components/ui/button";
import { CircleAlert, X } from "lucide-react";

export const OperationFailure = createContext<{ error: unknown; dialogOpen: boolean; dismiss: () => void } | null>(null);
export function ErrorNotice({ error }: { error: unknown }) {
  useI18n();
  const [copyStatus, setCopyStatus] = useState<{ diagnostic: string; status: "copied" | "failed" } | null>(null);
  const summary = errorMessage(error, false), diagnostic = errorMessage(error);
  let detail = diagnostic.startsWith(summary) ? diagnostic.slice(summary.length).trim() : diagnostic;
  const prefix = `${t("诊断详情")}:`;
  if (detail.startsWith(prefix)) detail = detail.slice(prefix.length).trim();
  return <div className="flex min-w-0 flex-col gap-2 break-words text-sm">
    <p>{summary}</p>
    {diagnostic !== summary && <details className="min-w-0 text-muted-foreground"><summary className="cursor-pointer">{t("诊断详情")}</summary><pre tabIndex={0} className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs select-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">{detail}</pre><div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2"><Button size="sm" variant="outline" onClick={() => { void Promise.resolve().then(() => navigator.clipboard.writeText(diagnostic)).then(() => setCopyStatus({ diagnostic, status: "copied" })).catch(() => setCopyStatus({ diagnostic, status: "failed" })); }}>{t("复制诊断")}</Button>{copyStatus?.diagnostic === diagnostic && <p role="status">{copyStatus.status === "copied" ? t("诊断已复制") : t("复制失败，请手动选择诊断文字。")}</p>}</div></details>}
  </div>;
}
export function OperationFeedback() {
  const failure = useContext(OperationFailure);
  useI18n();
  if (!failure) return null;
  return <div role="alert" className="flex w-full min-w-0 items-start gap-3 rounded-lg border bg-muted/25 p-3 text-left text-foreground">
    <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive" />
    <div className="min-w-0 flex-1"><ErrorNotice key={errorMessage(failure.error)} error={failure.error} /></div>
    <Button size="icon" variant="ghost" className="-mr-1 -mt-1 shrink-0 text-muted-foreground" aria-label={t("关闭提示")} onClick={failure.dismiss}><X /></Button>
  </div>;
}
