import Taro, { getCurrentInstance } from "@tarojs/taro";

export function routeNumber(name: string): number | null {
  const value = getCurrentInstance().router?.params?.[name];
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function routeText(name: string): string {
  return getCurrentInstance().router?.params?.[name] ?? "";
}

export function openPage(path: string, params: Record<string, string | number | undefined> = {}): Promise<TaroGeneral.CallbackResult> {
  const query = Object.entries(params).filter(([, value]) => value !== undefined).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join("&");
  return Taro.navigateTo({ url: query ? `${path}?${query}` : path });
}
