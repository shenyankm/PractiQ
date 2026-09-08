import { Image, Text } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePageApi, usePageClient, usePageLoad } from "../auth/protected-page";
import { viewAccess } from "../auth/view-access";
import { mediaIdForUrl } from "../media/temporary-media";
import { temporaryMedia } from "../media/taro-media";

declare const __PRACTIQ_API_URL__: string;

export function ProtectedImage({ url }: { url: string }): JSX.Element {
  const api = usePageApi();
  const client = usePageClient();
  const [path, setPath] = useState("");
  const [message, setMessage] = useState("正在验证图片权限…");
  const current = useRef("");
  const revision = useRef(0);
  const clear = useCallback(() => {
    revision.current += 1;
    temporaryMedia.remove(current.current);
    current.current = "";
    setPath("");
  }, []);
  const load = useCallback(async () => {
    clear();
    const ticket = revision.current;
    const id = mediaIdForUrl(url, __PRACTIQ_API_URL__);
    if (!id) { setMessage("图片来源无法验证，已阻止外部或内联图片加载。"); return; }
    try {
      const asset = await api.media.get(id);
      if (ticket !== revision.current) return;
      const result = await client.downloadMedia(id, { mime: asset.mime_type, size: Number(asset.size_bytes) });
      if (ticket !== revision.current) { temporaryMedia.remove(result.tempFilePath); return; }
      current.current = result.tempFilePath;
      setPath(result.tempFilePath);
    } catch (error) {
      if (ticket === revision.current) setMessage(error instanceof Error ? error.message : "图片不可访问");
      throw error;
    }
  }, [api, client, clear, url]);
  usePageLoad(load);
  Taro.useDidHide(clear);
  useEffect(() => viewAccess.subscribe(clear), [clear]);
  useEffect(() => { void load().catch(() => undefined); return clear; }, [clear, load]);
  return path ? <Image src={path} mode="widthFix" style={{ width: "100%" }} onError={() => { clear(); setMessage("图片无法显示"); }} /> : <Text className="app-muted">{message}</Text>;
}
