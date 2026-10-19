import { useState } from "react";
import { t, useI18n } from "./i18n";
import { EditorDialog } from "./EditorDialog";
import { DialogClose, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

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
  return <EditorDialog title={t(initial.id ? "编辑题库" : "新建题库")} dirty={dirty} busy={busy} onClose={onClose} trigger={trigger}>
    <fieldset disabled={busy} className="space-y-4">
      <Label htmlFor="bankTitle">{t("题库名称")}</Label>
      <Input id="bankTitle" value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} />
      <Label htmlFor="description">{t("说明")}</Label>
      <Textarea id="description" value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} />
    </fieldset>
    <DialogFooter>
      <DialogClose asChild><Button variant="outline" disabled={busy}>{t(dirty ? "放弃更改" : "取消")}</Button></DialogClose>
      <Button disabled={busy || !draft.title.trim()} onClick={() => onSave(draft)}>{t("保存题库")}</Button>
    </DialogFooter>
  </EditorDialog>;
}
