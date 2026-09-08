import Taro from "@tarojs/taro";
import { downloadImage } from "../media/download";
import { temporaryMedia, downloadPlatform } from "../media/taro-media";
import type { Transport } from "./client";

export const taroTransport: Transport = async ({
  url,
  method,
  headers,
  body,
  uploadFilePath,
  download,
}) => {
  if (download)
    return downloadImage(
      { url, method, headers },
      download,
      temporaryMedia,
      downloadPlatform,
    );
  if (uploadFilePath) {
    const response = await Taro.uploadFile({
      url,
      filePath: uploadFilePath,
      name: "file",
      header: headers,
      timeout: 60_000,
    });
    let data: unknown;
    try {
      data = JSON.parse(response.data) as unknown;
    } catch {
      data = undefined;
    }
    return { status: response.statusCode, data };
  }
  const response = await Taro.request({
    url,
    method,
    header: headers,
    data: body,
    timeout: 15_000,
  });
  return {
    status: response.statusCode,
    data: response.data,
  };
};
