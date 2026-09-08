import Taro from "@tarojs/taro";
import { viewAccess } from "../auth/view-access";
import { TemporaryMedia } from "./temporary-media";
import type { DownloadPlatform } from "./download";

export const temporaryMedia = new TemporaryMedia((path) => {
  Taro.getFileSystemManager().unlinkSync(path);
});
viewAccess.subscribe(() => temporaryMedia.clear());

export const downloadPlatform: DownloadPlatform = {
  async download(request) {
    let mime = "";
    let redirected = false;
    const task = Taro.downloadFile({ url: request.url, header: request.headers, timeout: 30_000 });
    task.onHeadersReceived(({ header }) => {
      for (const [key, value] of Object.entries(header)) {
        if (key.toLowerCase() === "content-type") mime = String(value).split(";")[0].trim().toLowerCase();
        if (key.toLowerCase() === "location") { redirected = true; task.abort(); }
      }
    });
    task.onProgressUpdate(({ totalBytesWritten, totalBytesExpectedToWrite }) => {
      if (Math.max(totalBytesWritten, totalBytesExpectedToWrite) > 10 * 1024 * 1024) task.abort();
    });
    const response = await task;
    return { status: redirected ? 502 : response.statusCode, path: response.tempFilePath, mime };
  },
  read(path) {
    const bytes = Taro.getFileSystemManager().readFileSync(path);
    if (typeof bytes === "string") throw new Error("Unexpected image encoding");
    return new Uint8Array(bytes);
  },
};
