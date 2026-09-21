import { toast as sonner } from "sonner";
import { errorMessage } from "./api";
import { renderMessage, useI18n, type Message } from "./i18n";
function Notice({ value, error = false }: { value: unknown; error?: boolean }) {
  useI18n();
  return <>{error ? errorMessage(value) : renderMessage(value as Message)}</>;
}
export const toast = {
  success: (value: Message) => sonner.success(<Notice value={value} />),
  info: (value: Message) => sonner.info(<Notice value={value} />),
  error: (value: unknown) => sonner.error(<Notice value={value} error />, { id: value instanceof Error ? value.message : typeof value === "object" ? JSON.stringify(value) : String(value) }),
};
