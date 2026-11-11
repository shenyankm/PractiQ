import type { DocumentReference } from "./contracts.generated";

export type SourceFile = Pick<File, "name" | "size"> & { arrayBuffer?: () => Promise<ArrayBuffer>; nativeTicket?: string };
export interface NativeBridge {
  origin: string;
  confirm(message: string): Promise<boolean>;
  fetch(path: string, init: RequestInit): Promise<Response>;
  pickSources(): Promise<SourceFile[]>;
  upload(ticket: string): Promise<DocumentReference>;
  importBank?(path: string): Promise<{bankId:string;count:number}>;
  download(path: string, name: string): Promise<boolean>;
  save(bytes: Uint8Array, name: string): Promise<boolean>;
}
let native: NativeBridge | null = null;
export const nativeBridge = () => native;
export function setNativeBridge(value: NativeBridge | null) { native = value; }
export function serviceFetch(path: string, init: RequestInit) { return native ? native.fetch(path, init) : fetch(path, init); }
