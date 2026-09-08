import Taro from "@tarojs/taro";
import { sessionStore } from "../auth/session";
import { ApiClient } from "./client";
import { taroTransport } from "./taro-transport";
import { viewAccess } from "../auth/view-access";
import { clearBusinessCache } from "../cache";
import { createApi } from "./modules";

declare const __PRACTIQ_API_URL__: string;

const apiUrl = __PRACTIQ_API_URL__.trim();

clearBusinessCache();
sessionStore.onReset((previous) => {
  viewAccess.invalidate("session");
  if (previous) clearBusinessCache(previous.user.id);
});

export const apiClient = new ApiClient({
  baseUrl: apiUrl,
  transport: taroTransport,
  session: sessionStore,
  readEpoch: viewAccess.readEpoch,
  onAccessFailure: (kind) => { viewAccess.invalidate(kind); clearBusinessCache(); },
  onUnauthenticated: () => {
    void Taro.reLaunch({ url: "/pages/login/index" });
  },
});

export const api = createApi(apiClient);
