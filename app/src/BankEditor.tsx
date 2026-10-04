import { useState } from "react";
import { t, useI18n } from "./i18n";
import { EditorDialog } from "./EditorDialog";
import { DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

export interface BankDraft { id: string | null; title: string; description: string }

export function BankEditor({ initial, busy, onClose, onSave }: {
  initial: BankDraft;
  busy: boolean;
  onClose: () => void;
  onSave: (draft: BankDraft) => void;
}) {
  useI18n();
  const [draft, setDraft] = useState(() => ({ ...initial }));
  const [original] = useState(() => ({ ...initial }));
  const dirty = draft.title !== original.title || draft.description !== original.description;
  return <EditorDialog title={t("编辑题库")} dirty={dirty} busy={busy} onClose={onClose}>
    <fieldset disabled={busy} className="space-y-4">
      <Label htmlFor="bankTitle">{t("题库名称")}</Label>
      <Input id="bankTitle" value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} />
      <Label htmlFor="description">{t("说明")}</Label>
      <Textarea id="description" value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} />
    </fieldset>
    <DialogFooter>
      <Button variant="outline" disabled={busy} onClick={onClose}>{t("放弃更改")}</Button>
      <Button disabled={busy || !draft.title.trim()} onClick={() => onSave(draft)}>{t("保存题库")}</Button>
    </DialogFooter>
  </EditorDialog>;
}
