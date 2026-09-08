import { isUserCacheKey } from "./keys";

export interface BusinessStorage { keys(): string[]; remove(key: string): void }
export function clearBusinessStorage(storage: BusinessStorage, userId?: number): void {
  for (const key of storage.keys()) {
    if (userId === undefined ? /^practiq:v2:\d+:/.test(key) : isUserCacheKey(userId, key)) storage.remove(key);
  }
}
