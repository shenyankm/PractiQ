export const userCacheKey = (userId: number, key: string): string => `practiq:v2:${userId}:${key}`;
export const isUserCacheKey = (userId: number, key: string): boolean => key.startsWith(`practiq:v2:${userId}:`);
