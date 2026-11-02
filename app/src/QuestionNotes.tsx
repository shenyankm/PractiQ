import { useEffect, useRef, useState } from "react";
import { NotebookPen } from "lucide-react";
import { api, type MistakeCause, type QuestionNote } from "./api";
import { t } from "./i18n";
import { EditorDialog } from "./EditorDialog";
import { ErrorNotice } from "./OperationFeedback";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { DialogClose } from "@/components/ui/dialog";

export function causeNames(): Record<MistakeCause, string> {
  return { knowledge:t("知识点不会"), misread:t("审题失误"), calculation:t("计算失误"), other:t("其他错因") };
}
export function QuestionNotesForTree({ rows, disabled }: { rows: {id:string;question:{stem:string|null}}[]; disabled:boolean }) {
  const [id, setId] = useState(rows[0].id);
  return <div className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
    {rows.length > 1 && <><Label htmlFor="note-question">{t("笔记所属题目")}</Label><NativeSelect id="note-question" value={id} onValueChange={setId} disabled={disabled}>{rows.map((row,index)=><NativeSelectOption key={row.id} value={row.id}>{index+1}. {row.question.stem?.slice(0,60) || t("原文未提供题干")}</NativeSelectOption>)}</NativeSelect></>}
    <QuestionNotesButton key={id} id={id} disabled={disabled}/>
  </div>;
}
export function QuestionNotesButton({ id, disabled = false }: { id: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return <><Button ref={trigger} variant="outline" disabled={disabled} onClick={() => setOpen(true)}><NotebookPen />{t("笔记与错因")}</Button>
    {open && <QuestionNotes id={id} onClose={() => setOpen(false)} trigger={trigger.current} />}</>;
}
export function QuestionNotes({ id, onClose, trigger }: { id: string; onClose: () => void; trigger?: HTMLElement | null }) {
  const [saved, setSaved] = useState<QuestionNote | null>(null);
  const [body, setBody] = useState("");
  const [cause, setCause] = useState<MistakeCause | "">("");
  const [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null), [retry, setRetry] = useState(0);
  const submitting = useRef(false);
  const dirty = loaded && (body !== (saved?.body ?? "") || cause !== (saved?.cause ?? ""));
  useEffect(() => {
    let active = true;
    void api({type:"question_note",id}).then(note => {
      if (active) { setSaved(note); setBody(note?.body ?? ""); setCause(note?.cause ?? ""); setLoaded(true); setError(null); }
    }).catch(error => { if (active) setError(error); });
    return () => { active = false; };
  }, [id,retry]);
  return <EditorDialog title={t("笔记与错因")} dirty={dirty} busy={busy} onClose={onClose} trigger={trigger} className="flex max-h-[85vh] flex-col sm:max-w-xl">
    <p className="text-sm text-muted-foreground">{t("笔记不随题库分享。")}</p>
    {error != null && <div role="alert" className="space-y-2"><ErrorNotice error={error}/>{!loaded && <Button variant="outline" onClick={() => setRetry(v=>v+1)}>{t("重试")}</Button>}</div>}
    {!loaded && error == null && <p role="status">{t("加载中…")}</p>}
    {loaded && <><fieldset disabled={busy} className="min-h-0 space-y-4 overflow-y-auto p-1">
      <div className="space-y-2"><Label htmlFor="question-mistake-cause">{t("错因")}</Label><NativeSelect id="question-mistake-cause" value={cause} onValueChange={value => setCause(value as MistakeCause | "")}><NativeSelectOption value="">{t("未标记错因")}</NativeSelectOption>{Object.entries(causeNames()).map(([value,label]) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}</NativeSelect></div>
      <div className="space-y-2"><Label htmlFor="question-personal-note">{t("个人笔记")}</Label><Textarea id="question-personal-note" rows={8} value={body} maxLength={20_000} onChange={event => setBody(event.target.value)} /></div>
    </fieldset><div className="flex shrink-0 justify-end gap-3 border-t pt-3"><DialogClose asChild><Button variant="outline" disabled={busy}>{t("取消")}</Button></DialogClose><Button disabled={busy || !dirty} onClick={() => void save()}>{busy ? t("正在保存…") : t("保存")}</Button></div></>}
  </EditorDialog>;
  async function save() {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setError(null);
    try { await api({type:"save_question_note",id,body,cause:cause || null}); onClose(); }
    catch(error) { setError(error); }
    finally { submitting.current = false; setBusy(false); }
  }
}
