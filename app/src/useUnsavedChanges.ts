import { useEffect } from "react";

const beforeWindowClose = "practiq-before-window-close";

// All mounted editors participate, including a parent behind a child dialog.
export function useUnsavedChanges(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const preventClose = (event: Event) => event.preventDefault();
    document.addEventListener(beforeWindowClose, preventClose);
    return () => document.removeEventListener(beforeWindowClose, preventClose);
  }, [dirty]);
}

export function canCloseWindow() {
  return document.dispatchEvent(new Event(beforeWindowClose, { cancelable: true }));
}
