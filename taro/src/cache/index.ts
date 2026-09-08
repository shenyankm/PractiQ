import Taro from "@tarojs/taro";
import { ApiClientError } from "../api/client";
import { isUserCacheKey, userCacheKey } from "./keys";

export const CACHE_TTL = {
  references: 24 * 60 * 60 * 1000,
  ownedBanks: 5 * 60 * 1000,
  analytics: 10 * 60 * 1000,
} as const;

interface CacheEntry<T> { userId: number; expiresAt: number; value: T }

export async function readUserCache<T>(userId: number, key: string): Promise<T | null> {
  try {
    const entry = await Taro.getStorage<CacheEntry<T>>({ key: userCacheKey(userId, key) });
    if (entry.data.userId !== userId || entry.data.expiresAt <= Date.now()) {
      await removeUserCache(userId, key);
      return null;
    }
    return entry.data.value;
  } catch {
    return null;
  }
}

export async function writeUserCache<T>(userId: number, key: string, value: T, ttl: number): Promise<void> {
  await Taro.setStorage({ key: userCacheKey(userId, key), data: { userId, value, expiresAt: Date.now() + ttl } satisfies CacheEntry<T> });
}

export async function removeUserCache(userId: number, key: string): Promise<void> {
  try { await Taro.removeStorage({ key: userCacheKey(userId, key) }); } catch { /* absent */ }
}

export async function clearUserCache(userId: number): Promise<void> {
  const storage = Taro.getStorageInfoSync();
  await Promise.all(storage.keys.filter((key) => isUserCacheKey(userId, key)).map(async (key) => {
    try { await Taro.removeStorage({ key }); } catch { /* best effort */ }
  }));
}

export async function cachedForUser<T>(userId: number, key: string, ttl: number, loader: () => Promise<T>, allowCache = true): Promise<T> {
  if (allowCache) {
    const cached = await readUserCache<T>(userId, key);
    if (cached !== null) return cached;
  }
  try {
    const value = await loader();
    if (allowCache) await writeUserCache(userId, key, value, ttl);
    return value;
  } catch (error) {
    if (error instanceof ApiClientError && (error.status === 403 || error.status === 404)) await removeUserCache(userId, key);
    throw error;
  }
}
