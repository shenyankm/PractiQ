import Taro from "@tarojs/taro";
import { clearBusinessStorage } from "./cleanup";

// Business reads are online-only; this removes caches written by older versions.
export function clearBusinessCache(userId?: number): void {
  clearBusinessStorage({ keys: () => Taro.getStorageInfoSync().keys, remove: (key) => Taro.removeStorageSync(key) }, userId);
}
export async function clearUserCache(userId: number): Promise<void> { clearBusinessCache(userId); }
