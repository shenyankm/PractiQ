import Taro from "@tarojs/taro";
import { apiClient } from "../api";
import { viewAccess } from "../auth/view-access";
import { PendingTransfers, type TransferFile } from "./pending-transfers";

export const pendingTransfers = new PendingTransfers((keys) => { void apiClient.forgetWriteKeys(keys); });
viewAccess.subscribe((event) => { if (event === "session" || event === "permission") pendingTransfers.clear(); });

export async function identifyTransferFile(path: string, name: string): Promise<TransferFile> {
  const info = await Taro.getFileInfo({ filePath: path, digestAlgorithm: "sha1" });
  if (!("digest" in info) || !("size" in info)) throw new Error("无法读取所选文件身份");
  return { path, name, digest: info.digest, size: info.size };
}
export async function verifyTransferFile(file: TransferFile): Promise<void> {
  try {
    const current = await identifyTransferFile(file.path, file.name);
    if (current.digest === file.digest && current.size === file.size) return;
  } catch { /* Missing native temp file has the same recovery policy as changed bytes. */ }
  throw new Error("原临时文件已丢失或改变，不能直接重放。请先核对服务端状态，明确放弃本地恢复后再选择新文件；放弃不会取消或删除服务端任务。");
}
