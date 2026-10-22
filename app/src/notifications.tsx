import { toast as sonner, type ExternalToast } from "sonner";
import { ErrorNotice } from "./OperationFeedback";
import { renderMessage, useI18n, type Message } from "./i18n";
function Notice({ value, error = false }: { value: unknown; error?: boolean }) {
  useI18n();
  return error ? <ErrorNotice error={value} /> : <>{renderMessage(value as Message)}</>;
}
export const toast = {
  success: (value: Message, options?: ExternalToast) => sonner.success(<Notice value={value} />, options),
  info: (value: Message) => sonner.info(<Notice value={value} />),
  error: (value: unknown) => sonner.error(<Notice value={value} error />, { duration: Infinity, closeButton: true, id: value instanceof Error ? value.message : typeof value === "object" ? JSON.stringify(value) : String(value) }),
};
