import type { AccountSession } from "./contracts.generated";
import { nativeBridge, serviceFetch } from "./transport";
let session: AccountSession | null = null;
export function setAccount(value: AccountSession | null) {
  session = value;
}
export function accountStorageScope() { return session?.user ? `${nativeBridge() ? ".service." + encodeURIComponent(nativeBridge()!.origin) : ""}.user.${session.user.id}` : ''; }
export function storageKey(key: string, scope = accountStorageScope()) { return key + scope; }
export function accountHeaders(headers: Headers) {
  if (session) headers.set("X-CSRF-Token", session.csrf);
}
export function sessionExpired() {
  window.dispatchEvent(new Event("practiq-session-expired"));
}
export async function accountRequest<T>(
  path: string,
  method = "GET",
  value?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const headers = new Headers();
  accountHeaders(headers);
  if (value !== undefined) headers.set("Content-Type", "application/json");
  const response = await serviceFetch(path, {
    method,
    headers,
    body: value === undefined ? undefined : JSON.stringify(value),
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    if (response.status === 401 && path !== "/api/auth/login") sessionExpired();
    throw new Error(data?.detail?.code ?? `请求失败 (${response.status})`);
  }
  return response.json() as Promise<T>;
}
