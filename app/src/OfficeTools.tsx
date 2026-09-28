import { useEffect, useRef, useState } from "react";
import { Button } from "./components/ui/button";
import { NativeSelect } from "./components/ui/native-select";
import { errorMessage } from "./api";
import { t, useI18n } from "./i18n";
import { office, type OfficeMode, type OfficeStatus } from "./office-api";

export function OfficeTools({ mode, onMode, busy, onBusy }: { mode: OfficeMode; onMode: (mode: OfficeMode) => void; busy: boolean; onBusy?: (busy: boolean) => void }) {
  useI18n();
  const [status, setStatus] = useState<OfficeStatus | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState<string[]>([]);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => { onBusy?.(working); return () => onBusy?.(false); }, [working, onBusy]);
  async function detect() {
    setWorking(true); setError(null);
    try {
      const result = await office({ type: "status" });
      if (mounted.current && result) setStatus(result);
    } catch (e) { if (mounted.current) setError(e); }
    finally { if (mounted.current) setWorking(false); }
  }
  async function convert() {
    setWorking(true); setError(null); setSaved([]);
    try {
      const result = await office({ type: "convert", mode });
      if (mounted.current && result) setSaved(result.paths);
    } catch (e) { if (mounted.current) setError(e); }
    finally { if (mounted.current) setWorking(false); }
  }
  const capabilities = [
    ["writer_pdf", t("Word → PDF")], ["writer_text", t("Word → TXT")],
    ["calc_pdf", t("Excel → PDF")], ["calc_text", t("Excel → 分表 CSV")],
  ] as const;
  return <section aria-label={t("内置文档转换")} className="space-y-3 rounded-lg border p-4 text-sm">
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-medium">{t("内置文档转换")}</span>
      <Button size="sm" variant="outline" disabled={working || busy} onClick={() => void detect()}>{t("检查转换组件")}</Button>
    </div>
    <p className="text-muted-foreground">{status ? status.path ? status.version : t("内置转换组件缺失或损坏，请重新安装 PractiQ。") : t("转换组件随应用提供，无需另行安装；首次转换时会自动检查。")}</p>
    {status?.path && <><ul className="flex flex-wrap gap-3">{capabilities.map(([key, label]) => <li key={key}>{label}：{status.capabilities[key] ? t("可用") : t("不可用")}</li>)}</ul></>}
    <div className="flex flex-wrap items-center gap-3">
      <label htmlFor="office-mode">{t("Word / Excel 处理方式")}</label>
      <NativeSelect id="office-mode" value={mode} disabled={busy || working} onChange={e => onMode(e.target.value as OfficeMode)}>
        <option value="pdf">{t("PDF：保留排版（默认）")}</option>
        <option value="text">{t("文本：Word TXT / Excel 分表 CSV")}</option>
      </NativeSelect>
      <Button variant="outline" disabled={working || busy} onClick={() => void convert()}>{t("转换／提取文件")}</Button>
      {(working || busy) && <Button variant="outline" onClick={() => { void office({ type: "cancel" }).catch(setError); }}>{t("取消本机转换")}</Button>}
    </div>
    <p className="text-muted-foreground">{mode === "pdf" ? t("Excel PDF 使用原文档打印布局，打印范围可能省略部分内容。") : t("文本模式会丢失图片、公式和排版；Excel 导出全部工作表，包括隐藏表。")}</p>
    <p className="text-muted-foreground">{t("独立转换仅在本机进行，无需模型配置；选择文档并确认解析后才调用 AI。")}</p>
    {working && <p role="status">{t("正在检测或转换，可取消。每次转换最多等待 180 秒。")}</p>}
    {error != null && <p role="alert">{errorMessage(error)}</p>}
    {saved.length > 0 && <div role="status"><p>{t("已导出 {0} 个文件", { 0: saved.length })}</p>{saved.map(path => <p key={path} className="break-all text-muted-foreground">{path}</p>)}</div>}
  </section>;
}
