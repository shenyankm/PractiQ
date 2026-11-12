import { useState } from "react";
import { t, useI18n } from "./i18n";
import { EditorDialog } from "./EditorDialog";
import { DialogClose, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { BANK_DESCRIPTION_LIMIT, BANK_TITLE_LIMIT } from "./api";

export interface BankDraft { id: string | null; title: string; description: string }

export function BankEditor({ initial, busy, onClose, onSave, trigger }: {
  initial: BankDraft;
  busy: boolean;
  onClose: () => void;
  onSave: (draft: BankDraft) => void;
  trigger?: HTMLElement | null;
}) {
  useI18n();
  const [draft, setDraft] = useState(() => ({ ...initial }));
  const [original] = useState(() => ({ ...initial }));
  const dirty = draft.title !== original.title || draft.description !== original.description;
  const titleLength = Array.from(draft.title.trim()).length;
  const descriptionLength = Array.from(draft.description).length;
  return <EditorDialog title={t(initial.id ? "编辑题库" : "新建题库")} dirty={dirty} busy={busy} onClose={onClose} trigger={trigger}>
    <fieldset disabled={busy} className="space-y-4">
      <Label htmlFor="bankTitle">{t("题库名称")}</Label>
      <Input id="bankTitle" aria-describedby="bank-title-count" aria-invalid={titleLength > BANK_TITLE_LIMIT} value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} />
      <p id="bank-title-count" className="text-xs text-muted-foreground">{t("{0} / {1} 字", { 0: titleLength, 1: BANK_TITLE_LIMIT })}</p>
      <Label htmlFor="description">{t("说明")}</Label>
      <Textarea id="description" aria-describedby="bank-description-count" aria-invalid={descriptionLength > BANK_DESCRIPTION_LIMIT} value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} />
      <p id="bank-description-count" className="text-xs text-muted-foreground">{t("{0} / {1} 字", { 0: descriptionLength, 1: BANK_DESCRIPTION_LIMIT })}</p>
    </fieldset>
    <DialogFooter>
      <DialogClose asChild><Button variant="outline" disabled={busy}>{t(dirty ? "放弃更改" : "取消")}</Button></DialogClose>
      <Button disabled={busy || !titleLength || titleLength > BANK_TITLE_LIMIT || descriptionLength > BANK_DESCRIPTION_LIMIT} onClick={() => onSave(draft)}>{t("保存题库")}</Button>
    </DialogFooter>
  </EditorDialog>;
}
