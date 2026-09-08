import Taro from "@tarojs/taro";
import { sessionStore } from "../auth/session";
import { ApiClient } from "./client";
import { taroTransport } from "./taro-transport";
import { createApi } from "./modules";

declare const __PRACTIQ_API_URL__: string;

const apiUrl = __PRACTIQ_API_URL__.trim();

export const apiClient = new ApiClient({
  baseUrl: apiUrl,
  transport: taroTransport,
  session: sessionStore,
  onUnauthenticated: () => {
    void Taro.reLaunch({ url: "/pages/login/index" });
  },
});

export const api = createApi(apiClient);
