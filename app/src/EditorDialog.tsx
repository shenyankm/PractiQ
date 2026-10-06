import { useRef, useState, type ReactNode } from "react";
import { t, useI18n } from "./i18n";
import { useUnsavedChanges } from "./useUnsavedChanges";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from "@/components/ui/alert-dialog";

export function EditorDialog({ title, dirty, busy, onClose, className, children }: {
  title: string;
  dirty: boolean;
  busy: boolean;
  onClose: () => void;
  className?: string;
  children: ReactNode;
}) {
  useI18n();
  useUnsavedChanges(dirty);
  const [discardOpen, setDiscardOpen] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  function requestClose() {
    if (busy) return;
    if (dirty) {
      setDiscardOpen(true);
    }
    else onClose();
  }
  return <Dialog open onOpenChange={open => { if (!open) requestClose(); }}>
    <DialogContent className={className} aria-describedby={undefined} onFocusCapture={event => {
      if (event.target instanceof HTMLElement) returnFocus.current = event.target;
    }} onPointerDownOutside={event => {
      if (!dirty) return;
      event.preventDefault();
      // Keep the outside pointer's default focus change from overtaking the confirmation.
      event.detail.originalEvent.preventDefault();
      requestClose();
    }}>
      <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
      {children}
    </DialogContent>
    <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
      <AlertDialogContent
        onCloseAutoFocus={event => {
          if (returnFocus.current?.isConnected) {
            event.preventDefault();
            returnFocus.current.focus();
          }
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{t("放弃未保存的更改？")}</AlertDialogTitle>
          <AlertDialogDescription>{t("更改尚未保存。放弃后将无法恢复。")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("继续编辑")}</AlertDialogCancel>
          <AlertDialogAction disabled={busy} onClick={onClose}>{t("放弃更改")}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </Dialog>;
}
