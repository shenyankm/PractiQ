import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ZodType } from 'zod';
import { apiRequestPage } from './api';
import { readResource, writeResource } from './cache';

// 结构化镜像读写通道:有 mirror 时替代 resources blob 缓存。
// write 的 reconcile 标记:仅当本次写入来自第一页完整拉取(hasMore=false)时为 true,
// 供镜像层做删除传播;分页合并写永远为 false。
export type ResourceMirror<T> = {
  read: () => Promise<T | null>;
  write: (value: T, options?: { reconcile: boolean }) => Promise<void>;
};

export function useCachedResource<T>(
  key: string,
  path: string,
  initial: T,
  schema: ZodType<T>,
  persist = true,
  mirror?: ResourceMirror<T>,
) {
  const [data, setData] = useState(initial);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [cursor, setCursor] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // mirror 描述符随渲染重建,用 ref 供回调取最新值,避免它进入 reload 依赖导致反复拉取。
  // 该 effect 声明在 useFocusEffect 之前,保证 focus 触发 reload 时 ref 已更新。
  const mirrorRef = useRef(mirror);
  useEffect(() => {
    mirrorRef.current = mirror;
  });

  const reload = useCallback(async () => {
    setRefreshing(true);
    setError('');
    const current = mirrorRef.current;
    // 镜像读取失败(DB 异常)按缓存未命中处理,不阻断网络拉取
    const cached = schema.safeParse(
      current ? await current.read().catch(() => null) : persist ? await readResource<unknown>(key) : null,
    );
    if (cached.success) {
      setData(cached.data);
      setLoading(false);
    }
    try {
      const page = await apiRequestPage<T>(path, { schema });
      setData(page.data);
      setCursor(page.cursor);
      setHasMore(page.hasMore);
      if (mirrorRef.current) await mirrorRef.current.write(page.data, { reconcile: !page.hasMore });
      else if (persist) await writeResource(key, page.data);
    } catch (reason) {
      if (!cached.success) setError(reason instanceof Error ? reason.message : '读取失败');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [key, path, persist, schema]);

  useFocusEffect(useCallback(() => {
    void reload();
  }, [reload]));

  const update = useCallback(async (value: T) => {
    setData(value);
    if (mirrorRef.current) await mirrorRef.current.write(value, { reconcile: false });
    else if (persist) await writeResource(key, value);
  }, [key, persist]);

  const loadMore = useCallback(async () => {
    if (!cursor || !hasMore || loadingMore) return;
    setLoadingMore(true);
    setError('');
    try {
      const separator = path.includes('?') ? '&' : '?';
      const page = await apiRequestPage<T>(`${path}${separator}cursor=${encodeURIComponent(cursor)}`, { schema });
      const merged = Array.isArray(data) && Array.isArray(page.data)
        ? [...data, ...page.data] as T
        : page.data;
      setData(merged);
      setCursor(page.cursor);
      setHasMore(page.hasMore);
      if (mirrorRef.current) await mirrorRef.current.write(merged, { reconcile: false });
      else if (persist) await writeResource(key, merged);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '读取失败');
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, data, hasMore, key, loadingMore, path, persist, schema]);

  return { data, loading, refreshing, loadingMore, hasMore, error, reload, loadMore, update };
}
