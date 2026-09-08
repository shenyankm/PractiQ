import { ApiClientError, type TransportRequest, type TransportResponse } from "../api/client";
import { TemporaryMedia, validImage } from "./temporary-media";

export interface ImageDownload { mime: string; size: number }
export interface DownloadPlatform {
  download(request: TransportRequest): Promise<{ status: number; path: string; mime: string }>;
  read(path: string): Uint8Array;
}
export async function downloadImage(request: TransportRequest, expected: ImageDownload, files: TemporaryMedia, platform: DownloadPlatform): Promise<TransportResponse> {
  const generation = files.generation();
  const result = await platform.download(request);
  if (!result.path && result.status !== 200) return { status: result.status };
  if (!files.accept(result.path, generation)) throw new ApiClientError(0, "STALE_RESPONSE", "媒体已失效");
  if (result.status !== 200) {
    files.remove(result.path);
    return { status: result.status, data: { error: { code: "MEDIA_UNAVAILABLE", message: "媒体不可访问" } } };
  }
  try {
    if (result.mime !== expected.mime || !validImage(platform.read(result.path), result.mime, expected.size)) throw new ApiClientError(0, "INVALID_MEDIA", "图片响应类型或大小不正确");
    return { status: 200, data: { data: { tempFilePath: result.path } } };
  } catch (error) { files.remove(result.path); throw error; }
}
