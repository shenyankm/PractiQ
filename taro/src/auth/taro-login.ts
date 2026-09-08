import Taro from "@tarojs/taro";
import type { WeChatLoginProvider } from "./wechat";

export const taroLoginProvider: WeChatLoginProvider = {
  login: () => Taro.login(),
};
