import { invoke } from "./transport";
import { locale } from "./i18n";
import { runSessionRequest, type Session } from "./api";

export type Request = {
  type: "grade";
  id: string;
  ordinal: number;
  retry: boolean;
  snapshot_key?: string;
};

export function ai(request: Request): Promise<Session> {
  return runSessionRequest(request.id, snapshotKey => invoke<Session>("ai_request", {
    request: snapshotKey ? { ...request, snapshot_key: snapshotKey } : request,
    locale: locale(),
  }));
}
