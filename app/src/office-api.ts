import { invoke } from "@tauri-apps/api/core";
import { locale } from "./i18n";

export type OfficeMode = "pdf" | "text";
export type OfficeStatus = {
  path: string | null;
  version: string | null;
  capabilities: Record<"writer_pdf" | "writer_text" | "calc_pdf" | "calc_text", boolean>;
  errors: Record<string, string>;
};
type Request = { type: "status" | "cancel" } | { type: "convert"; mode: OfficeMode };
type Response<R extends Request> = R extends { type: "convert" } ? { paths: string[]; count: number } | null : OfficeStatus | null;
export function office<R extends Request>(request: R): Promise<Response<R>> {
  return invoke("office_request", { request, locale: locale() });
}
