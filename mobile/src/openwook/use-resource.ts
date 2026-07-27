import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import type { ZodType } from 'zod';
import { apiRequestPage } from './api';
import { readResource, writeResource } from './cache';

export function useCachedResource<T>(key: string, path: string, initial: T, schema: ZodType<T>, persist = true) {
  const [data, setData] = useState(initial);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [cursor, setCursor] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const reload = useCallback(async () => {
    setRefreshing(true);
    setError('');
    const cached = schema.safeParse(persist ? await readResource<unknown>(key) : null);
    if (cached.success) {
      setData(cached.data);
      setLoading(false);
    }
    try {
      const page = await apiRequestPage<T>(path, { schema });
      setData(page.data);
      setCursor(page.cursor);
      setHasMore(page.hasMore);
      if (persist) await writeResource(key, page.data);
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
    if (persist) await writeResource(key, value);
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
      if (persist) await writeResource(key, merged);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '读取失败');
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, data, hasMore, key, loadingMore, path, persist, schema]);

  return { data, loading, refreshing, loadingMore, hasMore, error, reload, loadMore, update };
}
