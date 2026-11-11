import { errorMessage } from "./api";
import { invoke } from "./transport";
import { ApiError } from "../../shared/cloud/api";
import type { NativeBridge, SourceFile } from "../../shared/cloud/transport";
import type { DocumentReference } from "./contracts.generated";

export type CloudStatus = { origin: string | null; generation: number };

export async function cloudRequest<T>(request: Record<string, unknown>, context?: { origin: string; generation: number }): Promise<T> {
  try {
    const reply = await invoke<{value: T; generation: number}>("cloud_request", { request, context: context ? {...context} : null });
    if (context) context.generation = Math.max(context.generation, reply.generation);
    return reply.value;
  }
  catch (value) {
    const error = value as { code?: string; message?: string };
    throw new ApiError(errorMessage(error, false), error.code || "CLOUD_UNAVAILABLE");
  }
}
function encode(bytes: Uint8Array) {
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32768) parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
  return btoa(parts.join(""));
}
export function nativeCloudBridge(origin: string, generation = 0): NativeBridge {
  const context = {origin, generation};
  const call = <T,>(request: Record<string, unknown>) => cloudRequest<T>(request, context);
  return {
    origin,
    confirm: message => call<boolean>({ type: "confirm", message }),
    async fetch(path, init) {
      init.signal?.throwIfAborted();
      const response = await call<{ status: number; mediaType: string; bytes: string }>({ type: "fetch", path, method: init.method || "GET", body: typeof init.body === "string" ? JSON.parse(init.body) : null });
      init.signal?.throwIfAborted();
      return new Response(Uint8Array.from(atob(response.bytes), c => c.charCodeAt(0)), { status: response.status, headers: { "Content-Type": response.mediaType } });
    },
    pickSources: () => call<SourceFile[]>({ type: "pick_sources" }),
    upload: ticket => call<DocumentReference>({ type: "upload", ticket }),
    importBank: path => call<{bankId:string;count:number}>({ type: "import_bank", path }),
    download: (path, name) => call<boolean>({ type: "download", path, name }),
    save: (bytes, name) => call<boolean>({ type: "save", bytes: encode(bytes), name }),
  };
}
