import { createContext, useContext, useState } from "react";
import { errorMessage } from "./api";
import { t, useI18n } from "./i18n";
import { Button } from "@/components/ui/button";

export const OperationFailure = createContext<{ error: unknown; dialogOpen: boolean; dismiss: () => void } | null>(null);
export function ErrorNotice({ error }: { error: unknown }) {
  useI18n();
  const [copyStatus, setCopyStatus] = useState<"copied" | "failed" | null>(null);
  const summary = errorMessage(error, false), diagnostic = errorMessage(error);
  return <div className="flex min-w-0 flex-col gap-2 break-words">
    <p>{summary}</p>
    {diagnostic !== summary && <details><summary className="cursor-pointer">{t("诊断详情")}</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all text-sm select-text">{diagnostic}</pre><Button variant="outline" className="mt-2" onClick={() => { void Promise.resolve().then(() => navigator.clipboard.writeText(diagnostic)).then(() => setCopyStatus("copied")).catch(() => setCopyStatus("failed")); }}>{t("复制诊断")}</Button>{copyStatus && <p role="status">{copyStatus === "copied" ? t("诊断已复制") : t("复制失败，请手动选择诊断文字。")}</p>}</details>}
  </div>;
}
export function OperationFeedback() {
  const failure = useContext(OperationFailure);
  useI18n();
  if (!failure) return null;
  return <div role="alert" className="mt-2 flex w-full min-w-0 flex-col gap-3 rounded-xl border border-destructive/40 p-4 text-left text-destructive">
    <ErrorNotice key={errorMessage(failure.error)} error={failure.error} />
    <Button variant="outline" className="self-start" onClick={failure.dismiss}>{t("关闭提示")}</Button>
  </div>;
}
