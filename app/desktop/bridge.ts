export interface DesktopError { code: string; message: string; params?: Record<string, unknown> }
export type DesktopReply = { ok: true; value: unknown } | { ok: false; error: DesktopError };
export interface DesktopBridge {
  request(input: unknown, locale?: string): Promise<DesktopReply>;
  onCloseRequested(listener: () => void): () => void;
  close(): Promise<void>;
}
