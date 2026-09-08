import Taro from "@tarojs/taro";
import type { Transport } from "./client";

export const taroTransport: Transport = async ({ url, method, headers, body }) => {
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
